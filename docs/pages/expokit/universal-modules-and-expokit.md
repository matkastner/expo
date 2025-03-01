---
title: Universal Modules and ExpoKit
---

> ExpoKit is deprecated and is no longer supported after SDK 38. If you need to make customizations to your Expo project, we recommend using the [bare workflow](../workflow/customizing.md) instead.

Universal Modules are pieces of the Expo SDK with some special properties:

- They are optional; you can remove them from your ExpoKit build if you don't need their native code.
- They can run as standalone libraries without Expo.

Not all Expo SDK modules are Universal Modules. Right now, only a small part of our SDK has this property. We're continually expanding the number of our APIs that are available as universal modules.

# Omitting Unneeded Modules

When you [create an ExpoKit project](eject.md), we automatically add most of the same native APIs that are available in the Expo Go app. Each of these APIs is supported by some native code which increases the size of your native binary.

You can remove any Expo Universal Module from your ExpoKit project if you don't think you need it. This means it will no longer be available in your native binary; if you write some JS which tries to import this API, you might cause a fatal error in your app. If you send an [update](/archive/classic-updates/configuring-updates.md) to your app which contains API calls that aren't present in your native binary, you might cause a fatal error.

Omitting Universal Modules is currently supported on iOS but not Android.

> **If you aren't sure what this guide is for or whether you need this,** you are probably better off just leaving it alone. Otherwise you risk causing crashes in your app by ripping out needed APIs.

## iOS

To omit a Universal Module from your iOS ExpoKit project, remove the respective dependency from `ios/Podfile`. Then re-run `npx pod-install` and rebuild your native code.

### These modules are included by default, but can be omitted

- GL (`EXGL` and `EXGL-CPP`)
- SMS composer (`EXSMS`)
- Accelerometer, DeviceMotion, Gyroscope, Magnetometer, Pedometer (`EXSensors`)

### These modules are included by default, but can be dangerously omitted

Some modules implement core Expo functionality through a generic interface. For example, our `Permissions` module implements `expo-permissions-interface`. If you remove the Permissions module, the project will build, but it may not run unless you add some other code which provides Expo Permissions functionality.

- Camera (`EXCamera`)
- Constants (`EXConstants`)
- FileSystem (`EXFileSystem`)
- Permissions (`EXPermissions`)

## Android

Omitting Universal Modules is not currently supported on Android.

# Adding Optional Modules on iOS

A few Expo modules are not included by default in ExpoKit iOS projects, nor in Standalone iOS Apps produced by `expo build`. Typically this is either because they add a disproportionate amount of bloat to the binary, or because they include APIs that are governed by extra Apple review guidelines. Right now those modules are:

- FaceDetector (`EXFaceDetector`)
- ARKit
- Payments

If you want to use any of these modules in your Expo iOS app, you need to eject to ExpoKit rather than using `expo build`. (It's on our roadmap to improve this.)

To add FaceDetector:

1.  Add `expo-face-detector` to **package.json** and install JS dependencies.
2.  Add `pod 'EXFaceDetector', path: '../node_modules/expo-face-detector/ios'` to your `Podfile`.
3.  Re-run `npx pod-install`.

To add `Payments` or `AR`, add the [respective subspec](https://github.com/expo/expo/blob/sdk-38/ExpoKit.podspec) to your `ExpoKit` dependency in your `Podfile`, and re-run `npx pod-install`.
