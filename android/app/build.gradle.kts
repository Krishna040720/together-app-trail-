plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.together.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.together.app"
        minSdk = 26 // MediaProjection foreground-service type requires API 29+ at runtime,
                    // but we set minSdk 26 and gate screen share behind a version check
                    // so call/chat/movie features still work on slightly older phones.
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
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
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("androidx.constraintlayout:constraintlayout:2.1.4")
    implementation("androidx.lifecycle:lifecycle-service:2.8.1")
    implementation("com.google.android.material:material:1.12.0")

    // Real WebRTC SDK for Android (community-maintained build of Google's WebRTC,
    // since Google stopped publishing org.webrtc:google-webrtc directly).
    // Check https://github.com/webrtc-sdk/android for the latest version tag
    // if this one has been superseded by the time you build this.
    implementation("io.github.webrtc-sdk:android:125.6422.07")

    // Socket.IO client to talk to the same server.js signaling backend
    // the web app already uses.
    implementation("io.socket:socket.io-client:2.1.1") {
        exclude(group = "org.json", module = "json")
    }

    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
}
