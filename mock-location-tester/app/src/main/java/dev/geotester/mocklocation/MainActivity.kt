package dev.geotester.mocklocation

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Typeface
import android.location.Location
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.provider.Settings
import android.text.InputType
import android.view.View
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.util.Locale

/** Single-screen UI, built in code to keep the project free of layout resources and AndroidX. */
class MainActivity : Activity() {
    private lateinit var coords: EditText
    private lateinit var accuracy: EditText
    private lateinit var jitter: EditText
    private lateinit var altitude: EditText
    private lateinit var dest: EditText
    private lateinit var speed: EditText
    private lateinit var presetName: EditText
    private lateinit var presetList: LinearLayout
    private lateinit var status: TextView

    private val handler = Handler(Looper.getMainLooper())
    private val refresh = object : Runnable {
        override fun run() {
            renderStatus()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        title = "Mock Location Tester"

        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(px(16), px(8), px(16), px(24))
        }
        setContentView(ScrollView(this).apply { addView(root) })

        root.addView(note("For testing the location and geofence checks of an app you own. " +
            "Apps that read this device's location will see the position set below."))

        root.addView(header("1. One-time setup"))
        root.addView(note("Enable Developer options, then open \"Select mock location app\" and choose " +
            "Mock Location Tester. Without this, starting will fail."))
        root.addView(button("Open Developer options") { openDeveloperOptions() })

        root.addView(header("2. Location"))
        coords = field("12.9716, 77.5946", numeric = false)
        accuracy = field("", numeric = true)
        jitter = field("", numeric = true)
        altitude = field("", numeric = true)
        root.addView(labeled("Coordinates (paste \"lat, lng\" from Google Maps)", coords))
        root.addView(row(
            labeled("Accuracy (m)", accuracy),
            labeled("Jitter (m)", jitter),
            labeled("Altitude (m)", altitude),
        ))

        root.addView(header("3. Movement (optional)"))
        root.addView(note("Leave destination empty to stay put. With one set, the position walks there " +
            "at the given speed, which is useful for testing geofence entry and exit."))
        dest = field("", numeric = false)
        speed = field("", numeric = true)
        root.addView(labeled("Destination", dest))
        root.addView(labeled("Speed (km/h)", speed))

        root.addView(header("4. Run"))
        root.addView(row(
            button("Start / Apply") { startMocking() },
            button("Stop") { stopMocking() },
        ))
        status = TextView(this).apply {
            typeface = Typeface.MONOSPACE
            textSize = 12f
            setPadding(0, px(12), 0, 0)
        }
        root.addView(status)

        root.addView(header("Presets"))
        root.addView(note("Tap to load (applied immediately while running). Long-press to delete."))
        presetName = field("", numeric = false)
        presetName.hint = "Name, e.g. Office gate"
        root.addView(row(presetName, button("Save current") { savePreset() }))
        presetList = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        root.addView(presetList)

        writeForm(Store.loadLast(this))
        renderPresets()
    }

    override fun onResume() {
        super.onResume()
        handler.post(refresh)
    }

    override fun onPause() {
        handler.removeCallbacks(refresh)
        super.onPause()
    }

    // --- actions ---------------------------------------------------------------------------

    private fun startMocking() {
        val form = readForm()
        val config = try {
            form.toConfig()
        } catch (e: IllegalArgumentException) {
            toast(e.message ?: "Invalid input")
            return
        }
        Store.saveLast(this, form)

        if (!hasLocationPermission()) {
            val wanted = mutableListOf(
                Manifest.permission.ACCESS_FINE_LOCATION,
                Manifest.permission.ACCESS_COARSE_LOCATION,
            )
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                wanted += Manifest.permission.POST_NOTIFICATIONS
            }
            requestPermissions(wanted.toTypedArray(), REQ_PERMISSIONS)
            return
        }
        ServiceState.error = null
        startForegroundService(config.toIntent(this, MockLocationService.ACTION_START))
        renderStatus()
    }

    private fun stopMocking() {
        stopService(Intent(this, MockLocationService::class.java))
        renderStatus()
    }

    override fun onRequestPermissionsResult(
        requestCode: Int,
        permissions: Array<out String>,
        grantResults: IntArray,
    ) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode != REQ_PERMISSIONS) return
        if (hasLocationPermission()) {
            startMocking()
        } else {
            toast("Location permission is needed to run the mock service")
        }
    }

    private fun hasLocationPermission() =
        checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED

    private fun openDeveloperOptions() {
        try {
            startActivity(Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS))
        } catch (e: Exception) {
            try {
                startActivity(Intent(Settings.ACTION_DEVICE_INFO_SETTINGS))
                toast("Tap \"Build number\" 7 times to enable Developer options")
            } catch (e2: Exception) {
                toast("Open Settings > System > Developer options manually")
            }
        }
    }

    // --- presets ---------------------------------------------------------------------------

    private fun savePreset() {
        val form = readForm()
        if (Geo.parseLatLng(form.coords) == null) {
            toast("Enter valid coordinates first")
            return
        }
        val name = presetName.text.toString().trim().ifEmpty { form.coords.trim() }
        val presets = Store.loadPresets(this).filter { it.name != name } + Preset(name, form)
        Store.savePresets(this, presets)
        presetName.setText("")
        renderPresets()
    }

    private fun renderPresets() {
        presetList.removeAllViews()
        for (preset in Store.loadPresets(this)) {
            val b = Button(this).apply {
                text = "${preset.name}\n${preset.form.coords}"
                isAllCaps = false
                setOnClickListener {
                    writeForm(preset.form)
                    if (ServiceState.running) startMocking()
                }
                setOnLongClickListener {
                    AlertDialog.Builder(this@MainActivity)
                        .setMessage("Delete preset \"${preset.name}\"?")
                        .setPositiveButton("Delete") { _, _ ->
                            val remaining = Store.loadPresets(this@MainActivity).filter { p -> p.name != preset.name }
                            Store.savePresets(this@MainActivity, remaining)
                            renderPresets()
                        }
                        .setNegativeButton("Cancel", null)
                        .show()
                    true
                }
            }
            presetList.addView(b)
        }
    }

    // --- form <-> fields -------------------------------------------------------------------

    private fun readForm() = Form(
        coords = coords.text.toString(),
        accuracy = accuracy.text.toString(),
        jitter = jitter.text.toString(),
        altitude = altitude.text.toString(),
        dest = dest.text.toString(),
        speed = speed.text.toString(),
    )

    private fun writeForm(f: Form) {
        coords.setText(f.coords)
        accuracy.setText(f.accuracy)
        jitter.setText(f.jitter)
        altitude.setText(f.altitude)
        dest.setText(f.dest)
        speed.setText(f.speed)
    }

    // --- status ----------------------------------------------------------------------------

    private fun renderStatus() {
        val sb = StringBuilder()
        sb.append(if (ServiceState.running) "[ACTIVE] mocking\n" else "[STOPPED]\n")
        ServiceState.error?.let { sb.append("ERROR: ").append(it).append('\n') }
        if (ServiceState.running) {
            sb.append("providers: ").append(ServiceState.providers.joinToString()).append('\n')
            sb.append("play-services fused mock: ").append(ServiceState.fused).append('\n')
            ServiceState.position?.let {
                sb.append("publishing: ").append(fmt(it.lat, it.lng))
                sb.append(if (ServiceState.moving) "  (moving)\n" else "\n")
            }
        }
        sb.append("\nWhat other apps see (last known location):\n")
        if (hasLocationPermission()) {
            val lm = getSystemService(LOCATION_SERVICE) as LocationManager
            val providers = mutableListOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) providers += "fused"
            for (p in providers) {
                val loc = try {
                    lm.getLastKnownLocation(p)
                } catch (e: Exception) {
                    null
                }
                sb.append(String.format(Locale.US, "%-8s", p))
                sb.append(if (loc == null) "-\n" else describe(loc) + "\n")
            }
        } else {
            sb.append("(grant location permission to see this)\n")
        }
        status.text = sb.toString()
    }

    @Suppress("DEPRECATION") // isFromMockProvider is the pre-API-31 spelling of isMock.
    private fun describe(loc: Location): String {
        val mock = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) loc.isMock else loc.isFromMockProvider
        val ageS = (SystemClock.elapsedRealtimeNanos() - loc.elapsedRealtimeNanos) / 1_000_000_000L
        return String.format(
            Locale.US, "%s ±%.0fm isMock=%b age=%ds", fmt(loc.latitude, loc.longitude), loc.accuracy, mock, ageS,
        )
    }

    private fun fmt(lat: Double, lng: Double) = String.format(Locale.US, "%.6f, %.6f", lat, lng)

    // --- view helpers ----------------------------------------------------------------------

    private fun px(dp: Int) = (dp * resources.displayMetrics.density).toInt()

    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_LONG).show()

    private fun header(text: String) = TextView(this).apply {
        this.text = text
        textSize = 16f
        setTypeface(typeface, Typeface.BOLD)
        setPadding(0, px(20), 0, px(4))
    }

    private fun note(text: String) = TextView(this).apply {
        this.text = text
        textSize = 13f
        setTextColor(0xFF555555.toInt())
    }

    private fun field(hint: String, numeric: Boolean) = EditText(this).apply {
        this.hint = hint
        setSingleLine(true)
        inputType = if (numeric) {
            InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_FLAG_DECIMAL or InputType.TYPE_NUMBER_FLAG_SIGNED
        } else {
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
        }
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        isAllCaps = false
        setOnClickListener { onClick() }
    }

    private fun labeled(label: String, input: View) = LinearLayout(this).apply {
        orientation = LinearLayout.VERTICAL
        addView(TextView(this@MainActivity).apply {
            text = label
            textSize = 12f
        })
        addView(input)
    }

    private fun row(vararg views: View) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        for (v in views) {
            addView(v, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        }
    }

    private companion object {
        const val REQ_PERMISSIONS = 1
    }
}
