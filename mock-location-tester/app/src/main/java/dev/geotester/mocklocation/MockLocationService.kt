package dev.geotester.mocklocation

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.graphics.drawable.Icon
import android.location.Criteria
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationServices
import kotlin.math.sqrt
import kotlin.random.Random

/** Snapshot of the service for the UI to poll; the service and UI share one process. */
object ServiceState {
    @Volatile var running = false
    @Volatile var error: String? = null
    @Volatile var providers: List<String> = emptyList()
    @Volatile var fused: String = "off"
    @Volatile var position: LatLng? = null
    @Volatile var moving = false
}

/**
 * Publishes a simulated position once a second through Android's standard mock-location API
 * (LocationManager test providers, plus the Play services fused mock mode). The app must be chosen
 * under Developer options > "Select mock location app" or every call here throws SecurityException.
 */
class MockLocationService : Service() {
    private lateinit var lm: LocationManager
    private val handler = Handler(Looper.getMainLooper())
    private val activeProviders = mutableListOf<String>()

    private var cfg: MockConfig? = null
    private var current = LatLng(0.0, 0.0)
    private var headingDeg = 0.0
    private var travelling = false
    private var lastTickMs = 0L

    private var fusedClient: FusedLocationProviderClient? = null
    private var fusedReady = false

    private val tick = object : Runnable {
        override fun run() {
            pushLocation()
            if (ServiceState.running) handler.postDelayed(this, TICK_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        lm = getSystemService(LOCATION_SERVICE) as LocationManager
        val channel = NotificationChannel(CHANNEL_ID, "Mock location", NotificationManager.IMPORTANCE_LOW)
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent == null || intent.action != ACTION_START) {
            stopSelf()
            return START_NOT_STICKY
        }
        // startForegroundService() obliges us to call startForeground() before anything else.
        val inForeground = enterForeground()
        val config = MockConfig.fromIntent(intent)
        if (!inForeground || config == null || !applyConfig(config)) {
            stopSelf()
        }
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(tick)
        activeProviders.forEach { runCatching { lm.removeTestProvider(it) } }
        activeProviders.clear()
        if (fusedReady) runCatching { fusedClient?.setMockMode(false) }
        fusedReady = false
        ServiceState.running = false
        ServiceState.providers = emptyList()
        ServiceState.fused = "off"
        ServiceState.moving = false
        super.onDestroy()
    }

    private fun enterForeground(): Boolean {
        val notification = buildNotification()
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(NOTIF_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
            } else {
                startForeground(NOTIF_ID, notification)
            }
            true
        } catch (e: SecurityException) {
            ServiceState.error = "Location permission is required to run the mock service. " +
                "Grant it in the app's permission settings."
            false
        }
    }

    /** (Re)starts mocking with [config]; calling it while running teleports to the new start point. */
    private fun applyConfig(config: MockConfig): Boolean {
        cfg = config
        current = config.start
        travelling = config.destination != null
        headingDeg = 0.0
        lastTickMs = SystemClock.elapsedRealtime()

        if (activeProviders.isEmpty() && !setUpProviders()) return false
        if (fusedClient == null) enableFusedMock()

        ServiceState.error = null
        ServiceState.running = true
        handler.removeCallbacks(tick)
        handler.post(tick)
        return true
    }

    @Suppress("DEPRECATION") // addTestProvider(...) with ProviderProperties needs API 31; this works on all.
    private fun setUpProviders(): Boolean {
        var denied = false
        val problems = mutableListOf<String>()
        val names = mutableListOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) names += "fused"

        for (name in names) {
            try {
                // Clear a provider left behind by a previous run; harmless if there is none.
                runCatching { lm.removeTestProvider(name) }
                lm.addTestProvider(
                    name,
                    /* requiresNetwork = */ false,
                    /* requiresSatellite = */ false,
                    /* requiresCell = */ false,
                    /* hasMonetaryCost = */ false,
                    /* supportsAltitude = */ true,
                    /* supportsSpeed = */ true,
                    /* supportsBearing = */ true,
                    Criteria.POWER_LOW,
                    Criteria.ACCURACY_FINE,
                )
                lm.setTestProviderEnabled(name, true)
                activeProviders += name
            } catch (e: SecurityException) {
                denied = true
            } catch (e: Exception) {
                problems += "$name: ${e.message}"
            }
        }

        ServiceState.providers = activeProviders.toList()
        if (activeProviders.isEmpty()) {
            ServiceState.error = if (denied) NOT_MOCK_APP else problems.joinToString("; ")
            return false
        }
        return true
    }

    private fun enableFusedMock() {
        try {
            val client = LocationServices.getFusedLocationProviderClient(this)
            fusedClient = client
            ServiceState.fused = "starting"
            client.setMockMode(true)
                .addOnSuccessListener {
                    fusedReady = true
                    ServiceState.fused = "on"
                }
                .addOnFailureListener { ServiceState.fused = "unavailable (${it.message})" }
        } catch (e: Exception) {
            ServiceState.fused = "unavailable (${e.message})"
        }
    }

    private fun pushLocation() {
        val c = cfg ?: return
        val now = SystemClock.elapsedRealtime()
        val dt = ((now - lastTickMs) / 1000.0).coerceIn(0.0, 5.0)
        lastTickMs = now

        var speedMps = 0.0
        val dest = c.destination
        if (travelling && dest != null) {
            val step = c.speedKmh / 3.6 * dt
            if (Geo.distanceMeters(current, dest) <= step) {
                current = dest
                travelling = false
            } else {
                headingDeg = Geo.bearingDegrees(current, dest)
                current = Geo.offset(current, headingDeg, step)
                speedMps = c.speedKmh / 3.6
            }
        }
        val reported = if (c.jitterM > 0.0) jittered(current, c.jitterM) else current

        try {
            for (name in activeProviders) {
                lm.setTestProviderLocation(name, buildLocation(name, reported, c, speedMps))
            }
        } catch (e: SecurityException) {
            // The user un-selected this app as the mock location app while we were running.
            ServiceState.error = NOT_MOCK_APP
            stopSelf()
            return
        } catch (e: Exception) {
            ServiceState.error = "Could not publish location: ${e.message}"
        }

        if (fusedReady) {
            fusedClient?.setMockLocation(buildLocation("fused", reported, c, speedMps))
                ?.addOnFailureListener { ServiceState.fused = "error (${it.message})" }
        }
        ServiceState.position = reported
        ServiceState.moving = travelling
    }

    private fun buildLocation(provider: String, p: LatLng, c: MockConfig, speedMps: Double): Location {
        val loc = Location(provider)
        loc.latitude = p.lat
        loc.longitude = p.lng
        loc.accuracy = c.accuracyM
        loc.altitude = c.altitudeM
        loc.speed = speedMps.toFloat()
        if (speedMps > 0.0) loc.bearing = headingDeg.toFloat()
        loc.time = System.currentTimeMillis()
        loc.elapsedRealtimeNanos = SystemClock.elapsedRealtimeNanos()
        return loc
    }

    /** A uniformly random point within [radiusM] of [p], mimicking GPS noise. */
    private fun jittered(p: LatLng, radiusM: Double): LatLng =
        Geo.offset(p, Random.nextDouble() * 360.0, radiusM * sqrt(Random.nextDouble()))

    private fun buildNotification(): Notification {
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE,
        )
        val stop = PendingIntent.getService(
            this, 1,
            Intent(this, MockLocationService::class.java).setAction(ACTION_STOP),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val stopAction = Notification.Action.Builder(
            Icon.createWithResource(this, android.R.drawable.ic_menu_close_clear_cancel), "Stop", stop,
        ).build()
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle("Mock location active")
            .setContentText("Other apps are being fed a simulated position")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(stopAction)
            .build()
    }

    companion object {
        const val ACTION_START = "dev.geotester.mocklocation.START"
        const val ACTION_STOP = "dev.geotester.mocklocation.STOP"
        private const val CHANNEL_ID = "mock_location"
        private const val NOTIF_ID = 1
        private const val TICK_MS = 1000L
        const val NOT_MOCK_APP = "This app is not set as the mock location app. In Developer options, " +
            "open \"Select mock location app\" and choose Mock Location Tester."
    }
}
