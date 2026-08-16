plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.sentroid.agent"
    compileSdk = 34

    defaultConfig {
        // Supported range: Android 10 (API 29) through Android 16. minSdk 29
        // sets the floor; the app runs forward-compatibly on Android 16 at
        // targetSdk 34 (bumping to API 36 would require an AGP/Gradle upgrade
        // and the API 36 platform, which this toolchain doesn't carry).
        applicationId = "com.sentroid.agent"
        minSdk = 29
        targetSdk = 34
        versionCode = 6
        versionName = "1.5"

        // Default MDM server base URL. 10.0.2.2 is the host loopback as seen
        // from inside the Android emulator. Editable at runtime in the app.
        buildConfigField("String", "DEFAULT_SERVER", "\"http://10.0.2.2:4000\"")

        // Optional device-identity override for testing/demo on an emulator that
        // stands in for a specific target handset. Left empty so every build
        // reports the device's real hardware — required for a fleet of
        // different physical devices to show correctly in the console.
        buildConfigField("String", "DEVICE_MANUFACTURER_OVERRIDE", "\"\"")
        buildConfigField("String", "DEVICE_MODEL_OVERRIDE", "\"\"")
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
