package dev.geotester.mocklocation

import kotlin.math.asin
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin
import kotlin.math.sqrt

data class LatLng(val lat: Double, val lng: Double)

/** Pure spherical-earth math; accurate enough for sub-kilometre test movement. */
object Geo {
    private const val EARTH_RADIUS_M = 6_371_000.0

    fun distanceMeters(a: LatLng, b: LatLng): Double {
        val dLat = Math.toRadians(b.lat - a.lat)
        val dLng = Math.toRadians(b.lng - a.lng)
        val h = sin(dLat / 2) * sin(dLat / 2) +
            cos(Math.toRadians(a.lat)) * cos(Math.toRadians(b.lat)) * sin(dLng / 2) * sin(dLng / 2)
        return 2 * EARTH_RADIUS_M * asin(min(1.0, sqrt(h)))
    }

    /** Initial bearing from [a] to [b], in degrees clockwise from north (0..360). */
    fun bearingDegrees(a: LatLng, b: LatLng): Double {
        val lat1 = Math.toRadians(a.lat)
        val lat2 = Math.toRadians(b.lat)
        val dLng = Math.toRadians(b.lng - a.lng)
        val y = sin(dLng) * cos(lat2)
        val x = cos(lat1) * sin(lat2) - sin(lat1) * cos(lat2) * cos(dLng)
        return (Math.toDegrees(atan2(y, x)) + 360.0) % 360.0
    }

    /** The point [meters] away from [from] along [bearingDeg]. */
    fun offset(from: LatLng, bearingDeg: Double, meters: Double): LatLng {
        val ang = meters / EARTH_RADIUS_M
        val brg = Math.toRadians(bearingDeg)
        val lat1 = Math.toRadians(from.lat)
        val lng1 = Math.toRadians(from.lng)
        val lat2 = asin(sin(lat1) * cos(ang) + cos(lat1) * sin(ang) * cos(brg))
        val lng2 = lng1 + atan2(sin(brg) * sin(ang) * cos(lat1), cos(ang) - sin(lat1) * sin(lat2))
        return LatLng(Math.toDegrees(lat2), ((Math.toDegrees(lng2) + 540.0) % 360.0) - 180.0)
    }

    /**
     * Accepts what Google Maps copies ("12.9716, 77.5946"), plus space/semicolon separators and
     * surrounding brackets. Returns null for anything unparsable or out of range.
     */
    fun parseLatLng(text: String): LatLng? {
        val parts = text.trim().trim('(', ')', '[', ']')
            .split(Regex("[,;\\s]+"))
            .filter { it.isNotEmpty() }
        if (parts.size != 2) return null
        val lat = parts[0].toDoubleOrNull() ?: return null
        val lng = parts[1].toDoubleOrNull() ?: return null
        if (lat < -90.0 || lat > 90.0 || lng < -180.0 || lng > 180.0) return null
        return LatLng(lat, lng)
    }

    fun clamp(v: Double, lo: Double, hi: Double): Double = max(lo, min(hi, v))
}
