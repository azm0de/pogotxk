package com.pogotxk.app

import android.Manifest
import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlin.coroutines.resume
import kotlin.math.asin
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt
import kotlinx.coroutines.suspendCancellableCoroutine

/**
 * Works out which POI you are standing at.
 *
 * Uses the last known fix first and only falls back to a fresh one if there is
 * nothing cached. Waiting on a GPS lock would defeat the point: the bubble has
 * to answer in the time it takes to tap it, and every POI in the park is within
 * a few hundred metres of every other one anyway.
 */
object Nearby {

    fun hasLocationPermission(context: Context): Boolean =
        ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED ||
            ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED

    /** Great-circle distance in metres. */
    fun distanceMeters(lat1: Double, lng1: Double, lat2: Double, lng2: Double): Double {
        val r = 6_371_000.0
        val dLat = Math.toRadians(lat2 - lat1)
        val dLng = Math.toRadians(lng2 - lng1)
        val a = sin(dLat / 2) * sin(dLat / 2) +
            sin(dLng / 2) * sin(dLng / 2) * cos(Math.toRadians(lat1)) * cos(Math.toRadians(lat2))
        return 2 * r * asin(sqrt(a))
    }

    @SuppressLint("MissingPermission")
    suspend fun currentLocation(context: Context): Pair<Double, Double>? {
        if (!hasLocationPermission(context)) return null
        val client = LocationServices.getFusedLocationProviderClient(context)

        val cached = suspendCancellableCoroutine<Pair<Double, Double>?> { cont ->
            client.lastLocation
                .addOnSuccessListener { loc ->
                    cont.resume(loc?.let { it.latitude to it.longitude })
                }
                .addOnFailureListener { cont.resume(null) }
        }
        if (cached != null) return cached

        return suspendCancellableCoroutine { cont ->
            client
                .getCurrentLocation(Priority.PRIORITY_BALANCED_POWER_ACCURACY, null)
                .addOnSuccessListener { loc ->
                    cont.resume(loc?.let { it.latitude to it.longitude })
                }
                .addOnFailureListener { cont.resume(null) }
        }
    }

    /** Nearest POI of the given types, or null when we cannot place the user. */
    fun nearest(
        pois: List<Api.Poi>,
        location: Pair<Double, Double>?,
        types: Set<String>,
    ): Api.Poi? {
        if (location == null) return null
        return pois
            .filter { it.type in types }
            .minByOrNull { distanceMeters(location.first, location.second, it.lat, it.lng) }
    }
}
