plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.pos.dualscreen"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.pos.dualscreen"
        minSdk = 30 // Android 11 (OJ-D3 ships Android 11–14)
        targetSdk = 34
        versionCode = 3
        versionName = "1.0.2"
    }

    // One fixed key (GitHub secrets → env in CI) so every build installs over the last one.
    // Without SIGNING_KEYSTORE_FILE, local builds fall back to the machine's debug key.
    val keystoreFile = System.getenv("SIGNING_KEYSTORE_FILE")?.let { file(it) }?.takeIf { it.exists() }
    val shared = keystoreFile?.let {
        signingConfigs.create("shared") {
            storeFile = it
            storePassword = System.getenv("SIGNING_STORE_PASSWORD")
            keyAlias = System.getenv("SIGNING_KEY_ALIAS")
            keyPassword = System.getenv("SIGNING_STORE_PASSWORD")
        }
    }

    buildTypes {
        debug {
            if (shared != null) signingConfig = shared
        }
        release {
            isMinifyEnabled = false
            if (shared != null) signingConfig = shared
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
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.3")
    testImplementation("junit:junit:4.13.2")
}
