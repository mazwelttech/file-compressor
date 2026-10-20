plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "dev.geotester.mocklocation"
    compileSdk = 35

    defaultConfig {
        applicationId = "dev.geotester.mocklocation"
        minSdk = 26
        // Stay below 35 so the plain-View UI isn't forced edge-to-edge.
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // Only used for FusedLocationProviderClient.setMockMode/setMockLocation, so apps that read
    // location through Google Play services (not just LocationManager) also see the mock.
    implementation("com.google.android.gms:play-services-location:21.3.0")
}
