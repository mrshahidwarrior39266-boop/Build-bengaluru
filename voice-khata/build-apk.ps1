# Voice Khata Android APK Build Script
Write-Host "📱 Building Voice Khata Android APK..." -ForegroundColor Cyan

# 1. Sync web assets into Android project
Write-Host "🔄 Syncing latest web assets..." -ForegroundColor Yellow
npx cap sync android

# 2. Build debug APK using Gradle wrapper
if (Test-Path "android\gradlew.bat") {
    Write-Host "⚙️ Compiling Android APK with Gradle..." -ForegroundColor Yellow
    Set-Location android
    .\gradlew.bat assembleDebug
    Set-Location ..

    $apkPath = "android\app\build\outputs\apk\debug\app-debug.apk"
    if (Test-Path $apkPath) {
        Write-Host "✅ APK Build Succeeded! APK located at: $apkPath" -ForegroundColor Green
    } else {
        Write-Host "⚠️ Gradle build completed. Check android\app\build\outputs\apk for output." -ForegroundColor Yellow
    }
} else {
    Write-Host "❌ android\gradlew.bat not found. Run 'npx cap add android' first." -ForegroundColor Red
}
