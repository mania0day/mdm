plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.sentroid.agent"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.sentroid.agent"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"

        // Default MDM server base URL. 10.0.2.2 is the host loopback as seen
        // from inside the Android emulator. Editable at runtime in the app.
        buildConfigField("String", "DEFAULT_SERVER", "\"http://10.0.2.2:4000\"")

        // Optional device-identity override for testing/demo on an emulator that
        // stands in for a specific target handset. Leave both empty ("") to report
        // the device's real hardware (the correct behaviour for production builds).
        // Set here so this test build represents the organization's Redmi Note 9.
        buildConfigField("String", "DEVICE_MANUFACTURER_OVERRIDE", "\"Xiaomi\"")
        buildConfigField("String", "DEVICE_MODEL_OVERRIDE", "\"Redmi Note 9\"")
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro",
            )
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
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
}
