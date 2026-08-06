plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.pogotxk.app"
    compileSdk = 35

    defaultConfig {
        applicationId = "com.pogotxk.app"
        // TYPE_APPLICATION_OVERLAY — the API the floating bubble is built on —
        // arrived in Oreo. Nothing older can draw over another app.
        minSdk = 26
        targetSdk = 35
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = false
        // For BuildConfig.DEBUG, which gates the bubble-without-sign-in
        // affordance used to test the overlay on an emulator.
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    // Fused location gives a cached fix immediately, which matters when the
    // whole point is one tap without waiting for a GPS lock.
    implementation("com.google.android.gms:play-services-location:21.3.0")
}
