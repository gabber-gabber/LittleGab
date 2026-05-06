plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.local.phonemacbridge"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.local.phonemacbridge"
        minSdk = 24
        targetSdk = 34
        versionCode = 8
        versionName = "0.5.1"
        vectorDrawables.useSupportLibrary = true
    }

    signingConfigs {
        create("release") {
            val home = System.getProperty("user.home")
            storeFile = file(
                System.getenv("KEYSTORE_PATH") ?: "$home/.phone-mac-bridge/release.keystore"
            )
            storePassword = System.getenv("KEYSTORE_PASSWORD") ?: "phonemacbridge"
            keyAlias = System.getenv("KEY_ALIAS") ?: "phonemacbridge"
            keyPassword = System.getenv("KEY_PASSWORD") ?: "phonemacbridge"
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug {
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

    buildFeatures {
        viewBinding = true
    }

    packaging {
        resources.excludes += setOf(
            "META-INF/LICENSE*",
            "META-INF/NOTICE*",
            "META-INF/*.kotlin_module",
        )
    }
}

dependencies {
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.webkit:webkit:1.11.0")
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.7")
    implementation("androidx.recyclerview:recyclerview:1.3.2")
    implementation("androidx.swiperefreshlayout:swiperefreshlayout:1.1.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
    implementation("com.google.zxing:core:3.5.3")
    // OkHttp is only for the background NotifyService's WebSocket — the
    // in-app terminal still uses the WebView's native WebSocket client.
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    // ShortcutBadger normalises launcher-icon badge across OEMs (Samsung,
    // Xiaomi, Huawei, OPPO/ColorOS, …) so the red dot shows on this user's
    // ColorOS phone without us hand-rolling each broadcast format.
    implementation("me.leolin:ShortcutBadger:1.1.22@aar")
}
