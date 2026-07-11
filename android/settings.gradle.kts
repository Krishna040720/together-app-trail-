pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
        // WebRTC Android builds are published here (google-webrtc on Maven
        // Central sometimes lags — this mirror keeps things current):
        maven { url = uri("https://maven.google.com") }
    }
}

rootProject.name = "Together"
include(":app")
