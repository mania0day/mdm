// Imported explicitly: inside a Kotlin-DSL build script `java` resolves to
// Gradle's own java extension, so the fully-qualified java.util.Properties
// cannot be referenced inline.
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Stable RELEASE signing identity for fleet provisioning.
//
// Why this matters: the Device Owner provisioning QR embeds
// PROVISIONING_DEVICE_ADMIN_SIGNATURE_CHECKSUM, which Android verifies against
// the downloaded APK. The debug keystore is generated per-machine, so a
// debug-signed build produces a DIFFERENT checksum on every developer machine
// and every CI box — every previously-printed QR would stop provisioning. A
// fixed release key makes the checksum reproducible for the life of the fleet.
//
// Credentials live in android-agent/keystore.properties (gitignored — never
// committed). Create it with ./make-release-key.sh. If it is absent the build
// still works and falls back to debug signing, which is fine for local testing
// but must not be used for a real fleet.
val keystorePropsFile = rootProject.file("keystore.properties")
val keystoreProps = Properties().apply {
    if (keystorePropsFile.exists()) keystorePropsFile.inputStream().use { stream -> load(stream) }
}
val hasReleaseKeystore = keystoreProps.getProperty("storeFile")?.let { file(it).exists() } == true

android {
    namespace = "com.sentroid.agent"
    compileSdk = 34

    signingConfigs {
        if (hasReleaseKeystore) {
            create("release") {
                storeFile = file(keystoreProps.getProperty("storeFile"))
                storePassword = keystoreProps.getProperty("storePassword")
                keyAlias = keystoreProps.getProperty("keyAlias")
                keyPassword = keystoreProps.getProperty("keyPassword")
            }
        }
    }

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
            // Sign with the fixed fleet key when it is configured, so the
            // provisioning QR's signature checksum stays constant across
            // machines and rebuilds. Without keystore.properties this stays
            // unset and Gradle leaves the release build unsigned.
            if (hasReleaseKeystore) {
                signingConfig = signingConfigs.getByName("release")
            }
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
