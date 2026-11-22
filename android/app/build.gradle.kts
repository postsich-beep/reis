plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Номер збірки і сховище оновлень підставляє GitHub Actions: -PvCode=… -PvName=… -PupdateRepo=owner/repo
val vCode = (project.findProperty("vCode") as String?)?.toIntOrNull() ?: 1
val vName = (project.findProperty("vName") as String?) ?: "1.0.0"
val updateRepo = (project.findProperty("updateRepo") as String?) ?: ""
// Номер «рідної» частини (Kotlin): росте лише тоді, коли міняється сама оболонка — тоді плашка пропонує новий APK
val nativeRev = (project.findProperty("nativeRev") as String?)?.toIntOrNull() ?: 0

android {
    namespace = "ua.reis.nav"
    compileSdk = 34

    defaultConfig {
        applicationId = "ua.reis.nav"
        minSdk = 26
        targetSdk = 34
        versionCode = vCode
        versionName = vName
        buildConfigField("String", "UPDATE_REPO", "\"$updateRepo\"")
        buildConfigField("int", "NATIVE_REV", "$nativeRev")
    }
    buildFeatures { buildConfig = true }

    signingConfigs {
        // Один і той самий ключ у кожній збірці — інакше Android не поставить оновлення поверх старої версії.
        create("release") {
            storeFile = file("../keystore/reis.jks")
            storePassword = "reis-nav-2026"
            keyAlias = "reis"
            keyPassword = "reis-nav-2026"
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = signingConfigs.getByName("release")
        }
        debug { signingConfig = signingConfigs.getByName("release") }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    lint { abortOnError = false; checkReleaseBuilds = false }
    // рушій голосу (.so) — стиснутим у APK: менше качати; Android розпакує під час встановлення
    packaging { jniLibs { useLegacyPackaging = true } }
}
