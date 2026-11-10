package ai.boltibahi.app;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Bundle;
import android.text.InputType;
import android.view.ViewGroup;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

/**
 * Bolti Bahi phone client.
 *
 * The ledger and the Gnani key live on the Bolti Bahi server, so this shell
 * loads the server URL the shopkeeper chooses on first launch. The in-app
 * Settings panel (web UI) then stores the Gnani key server-side.
 */
public class MainActivity extends Activity {
    private static final String PREFS = "bolti_bahi";
    private static final String KEY_URL = "server_url";
    private static final int MIC_REQUEST = 101;

    private WebView webView;
    private PermissionRequest pendingPermission;
    private boolean dialogOpen = false;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        FrameLayout root = new FrameLayout(this);
        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#F5F0EB"));
        root.addView(webView, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);

        webView.addJavascriptInterface(new Object() {
            @JavascriptInterface
            public void changeServer() {
                runOnUiThread(() -> showServerDialog(false));
            }
        }, "AndroidHost");

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    boolean wantsAudio = false;
                    for (String resource : request.getResources()) {
                        if ("android.webkit.resource.AUDIO_CAPTURE".equals(resource)) wantsAudio = true;
                    }
                    if (!wantsAudio) {
                        request.deny();
                        return;
                    }
                    if (checkSelfPermission(android.Manifest.permission.RECORD_AUDIO)
                            != PackageManager.PERMISSION_GRANTED) {
                        pendingPermission = request;
                        requestPermissions(new String[]{android.Manifest.permission.RECORD_AUDIO}, MIC_REQUEST);
                    } else {
                        request.grant(request.getResources());
                    }
                });
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
                // Debug build: accept the shop LAN's self-signed HTTPS certificate
                // so the WebView gets a secure origin and getUserMedia works.
                handler.proceed();
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) {
                    Toast.makeText(MainActivity.this,
                            "Server se sampark nahi hua. URL check karein.",
                            Toast.LENGTH_LONG).show();
                    showServerDialog(false);
                }
            }
        });

        String saved = getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString(KEY_URL, "");
        if (saved == null || saved.trim().isEmpty()) {
            showServerDialog(true);
        } else {
            webView.loadUrl(saved);
        }
    }

    @Override
    public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        if (code == MIC_REQUEST) {
            if (results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED
                    && pendingPermission != null) {
                pendingPermission.grant(pendingPermission.getResources());
            } else if (pendingPermission != null) {
                pendingPermission.deny();
                Toast.makeText(this, "Mic permission ke bina voice nahi chalega.", Toast.LENGTH_LONG).show();
            }
            pendingPermission = null;
        }
    }

    private void showServerDialog(boolean firstRun) {
        if (dialogOpen) return;
        dialogOpen = true;

        SharedPreferences prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String saved = prefs.getString(KEY_URL, "http://192.168.1.5:3000");

        final EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_TEXT_VARIATION_URI);
        input.setSingleLine(true);
        input.setText(saved);
        input.setSelection(input.getText().length());

        AlertDialog.Builder builder = new AlertDialog.Builder(this)
                .setTitle(firstRun ? "Bolti Bahi server" : "Server URL")
                .setMessage("Jis computer par Bolti Bahi chal raha hai uska address daalein "
                        + "(jaise https://192.168.1.5:3443). Mic ke liye HTTPS zaroori hai.")
                .setView(input)
                .setPositiveButton("Connect", (dialog, which) -> {
                    dialogOpen = false;
                    String url = input.getText().toString().trim();
                    if (!url.startsWith("http://") && !url.startsWith("https://")) {
                        url = "https://" + url;
                    }
                    prefs.edit().putString(KEY_URL, url).apply();
                    webView.loadUrl(url);
                })
                .setNegativeButton("Cancel", (dialog, which) -> {
                    dialogOpen = false;
                    if (firstRun) finish();
                })
                .setCancelable(!firstRun);

        // Tapping outside the dialog must not leave the guard stuck on.
        builder.setOnDismissListener(dialog -> { dialogOpen = false; });
        builder.show();
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
