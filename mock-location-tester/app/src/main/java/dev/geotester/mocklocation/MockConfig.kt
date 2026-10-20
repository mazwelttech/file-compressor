package dev.geotester.mocklocation

import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject

/** Validated settings handed to [MockLocationService]. */
data class MockConfig(
    val start: LatLng,
    val accuracyM: Float,
    val altitudeM: Double,
    val jitterM: Double,
    val destination: LatLng?,
    val speedKmh: Double,
) {
    fun toIntent(context: Context, action: String): Intent =
        Intent(context, MockLocationService::class.java).setAction(action).apply {
            putExtra(K_LAT, start.lat)
            putExtra(K_LNG, start.lng)
            putExtra(K_ACC, accuracyM)
            putExtra(K_ALT, altitudeM)
            putExtra(K_JITTER, jitterM)
            putExtra(K_SPEED, speedKmh)
            putExtra(K_HAS_DEST, destination != null)
            if (destination != null) {
                putExtra(K_DLAT, destination.lat)
                putExtra(K_DLNG, destination.lng)
            }
        }

    companion object {
        private const val K_LAT = "lat"
        private const val K_LNG = "lng"
        private const val K_ACC = "acc"
        private const val K_ALT = "alt"
        private const val K_JITTER = "jitter"
        private const val K_SPEED = "speed"
        private const val K_HAS_DEST = "hasDest"
        private const val K_DLAT = "dlat"
        private const val K_DLNG = "dlng"

        fun fromIntent(i: Intent): MockConfig? {
            if (!i.hasExtra(K_LAT) || !i.hasExtra(K_LNG)) return null
            val dest = if (i.getBooleanExtra(K_HAS_DEST, false)) {
                LatLng(i.getDoubleExtra(K_DLAT, 0.0), i.getDoubleExtra(K_DLNG, 0.0))
            } else {
                null
            }
            return MockConfig(
                start = LatLng(i.getDoubleExtra(K_LAT, 0.0), i.getDoubleExtra(K_LNG, 0.0)),
                accuracyM = i.getFloatExtra(K_ACC, 5f),
                altitudeM = i.getDoubleExtra(K_ALT, 10.0),
                jitterM = i.getDoubleExtra(K_JITTER, 0.0),
                destination = dest,
                speedKmh = i.getDoubleExtra(K_SPEED, 5.0),
            )
        }
    }
}

/** The raw text of the input fields, so half-typed values survive a restart. */
data class Form(
    val coords: String = "",
    val accuracy: String = "5",
    val jitter: String = "0",
    val altitude: String = "10",
    val dest: String = "",
    val speed: String = "5",
) {
    /** @throws IllegalArgumentException with a user-facing message when a field is invalid. */
    fun toConfig(): MockConfig {
        val start = Geo.parseLatLng(coords)
            ?: throw IllegalArgumentException("Enter coordinates as \"lat, lng\", e.g. 12.9716, 77.5946")
        val acc = accuracy.ifBlank { "5" }.toFloatOrNull()?.takeIf { it > 0f }
            ?: throw IllegalArgumentException("Accuracy must be a number above 0")
        val jit = jitter.ifBlank { "0" }.toDoubleOrNull()?.takeIf { it >= 0.0 }
            ?: throw IllegalArgumentException("Jitter must be 0 or more")
        val alt = altitude.ifBlank { "0" }.toDoubleOrNull()
            ?: throw IllegalArgumentException("Altitude must be a number")
        val destination = if (dest.isBlank()) {
            null
        } else {
            Geo.parseLatLng(dest)
                ?: throw IllegalArgumentException("Destination must be \"lat, lng\" or left empty")
        }
        val spd = speed.ifBlank { "5" }.toDoubleOrNull()?.takeIf { it > 0.0 }
            ?: throw IllegalArgumentException("Speed must be a number above 0")
        return MockConfig(start, acc, alt, jit, destination, spd)
    }

    fun toJson(): JSONObject = JSONObject()
        .put("coords", coords).put("accuracy", accuracy).put("jitter", jitter)
        .put("altitude", altitude).put("dest", dest).put("speed", speed)

    companion object {
        fun fromJson(o: JSONObject): Form {
            val d = Form()
            return Form(
                coords = o.optString("coords", d.coords),
                accuracy = o.optString("accuracy", d.accuracy),
                jitter = o.optString("jitter", d.jitter),
                altitude = o.optString("altitude", d.altitude),
                dest = o.optString("dest", d.dest),
                speed = o.optString("speed", d.speed),
            )
        }
    }
}

data class Preset(val name: String, val form: Form)

/** SharedPreferences-backed storage for the last-used form and named presets. */
object Store {
    private const val FILE = "mock_location_tester"
    private const val KEY_LAST = "last_form"
    private const val KEY_PRESETS = "presets"

    private fun prefs(c: Context) = c.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun loadLast(c: Context): Form =
        prefs(c).getString(KEY_LAST, null)?.let { runCatching { Form.fromJson(JSONObject(it)) }.getOrNull() }
            ?: Form()

    fun saveLast(c: Context, form: Form) {
        prefs(c).edit().putString(KEY_LAST, form.toJson().toString()).apply()
    }

    fun loadPresets(c: Context): List<Preset> {
        val raw = prefs(c).getString(KEY_PRESETS, null) ?: return emptyList()
        return runCatching {
            val arr = JSONArray(raw)
            (0 until arr.length()).map {
                val o = arr.getJSONObject(it)
                Preset(o.getString("name"), Form.fromJson(o.getJSONObject("form")))
            }
        }.getOrDefault(emptyList())
    }

    fun savePresets(c: Context, presets: List<Preset>) {
        val arr = JSONArray()
        presets.forEach { arr.put(JSONObject().put("name", it.name).put("form", it.form.toJson())) }
        prefs(c).edit().putString(KEY_PRESETS, arr.toString()).apply()
    }
}
