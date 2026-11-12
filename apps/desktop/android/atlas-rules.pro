# Release shrinking rules for the Android app's own code, copied next to
# the generated rules by `scripts/build.js android`.
#
# The page calls window.AtlasAndroid (MainActivity.Bars: insets,
# darkIcons, keepScreenOn) by method name,
# and the WebView finds those methods by their @JavascriptInterface
# annotation: keep both.
-keepattributes RuntimeVisibleAnnotations
-keepclassmembers class * {
  @android.webkit.JavascriptInterface <methods>;
}
