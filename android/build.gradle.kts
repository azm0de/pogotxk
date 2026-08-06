// Versions match what is already in the local Gradle cache, so a build here
// needs as little network as possible.
plugins {
    id("com.android.application") version "8.13.1" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
