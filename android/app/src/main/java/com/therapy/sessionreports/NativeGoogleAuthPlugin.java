package com.therapy.sessionreports;

import android.app.Activity;
import android.content.Intent;

import androidx.activity.result.ActivityResult;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.auth.GoogleAuthException;
import com.google.android.gms.auth.GoogleAuthUtil;
import com.google.android.gms.auth.UserRecoverableAuthException;
import com.google.android.gms.auth.api.signin.GoogleSignIn;
import com.google.android.gms.auth.api.signin.GoogleSignInAccount;
import com.google.android.gms.auth.api.signin.GoogleSignInClient;
import com.google.android.gms.auth.api.signin.GoogleSignInOptions;
import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.tasks.Task;

import java.io.IOException;
import java.util.ArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@CapacitorPlugin(name = "NativeGoogleAuth")
public class NativeGoogleAuthPlugin extends Plugin {
    private static final String DEFAULT_SCOPE = "https://www.googleapis.com/auth/drive.file";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();

    @PluginMethod
    public void signIn(PluginCall call) {
        GoogleSignInOptions.Builder builder = new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestEmail()
            .requestProfile();

        GoogleSignInClient client = GoogleSignIn.getClient(getActivity(), builder.build());
        startActivityForResult(call, client.getSignInIntent(), "signInResult");
    }

    @PluginMethod
    public void signOut(PluginCall call) {
        GoogleSignIn.getClient(getActivity(), new GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN).build())
            .signOut()
            .addOnCompleteListener(task -> call.resolve());
    }

    @ActivityCallback
    private void signInResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            GoogleSignInAccount lastAccount = GoogleSignIn.getLastSignedInAccount(getContext());
            if (lastAccount != null) {
                fetchAccessToken(call, lastAccount, readScopes(call));
                return;
            }
            call.reject("בחירת חשבון Google בוטלה או נחסמה. אם לא ביטלת ידנית, יש לבדוק שהוגדר Android OAuth client עם package name ו-SHA-1 נכונים.");
            return;
        }

        Task<GoogleSignInAccount> task = GoogleSignIn.getSignedInAccountFromIntent(result.getData());
        try {
            GoogleSignInAccount account = task.getResult(ApiException.class);
            ArrayList<String> requestedScopes = readScopes(call);
            fetchAccessToken(call, account, requestedScopes);
        } catch (ApiException error) {
            call.reject("Google sign-in failed. status=" + error.getStatusCode() + " message=" + error.getMessage());
        }
    }

    @ActivityCallback
    private void recoverAuthResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK) {
            call.reject("Google authorization was cancelled.");
            return;
        }

        GoogleSignInAccount account = GoogleSignIn.getLastSignedInAccount(getContext());
        if (account == null) {
            call.reject("Google account was not available after authorization.");
            return;
        }

        fetchAccessToken(call, account, readScopes(call));
    }

    private void fetchAccessToken(PluginCall call, GoogleSignInAccount account, ArrayList<String> requestedScopes) {
        executor.execute(() -> {
            try {
                String token = GoogleAuthUtil.getToken(getContext(), account.getAccount(), buildOAuthScope(requestedScopes));
                JSObject result = new JSObject();
                result.put("accessToken", token);
                result.put("userId", account.getId() != null ? account.getId() : account.getEmail());
                result.put("email", account.getEmail());
                result.put("displayName", account.getDisplayName() != null ? account.getDisplayName() : account.getEmail());
                call.resolve(result);
            } catch (UserRecoverableAuthException recoverable) {
                Intent intent = recoverable.getIntent();
                if (intent == null) {
                    call.reject("Google authorization requires recovery, but no recovery intent was returned.");
                    return;
                }
                getActivity().runOnUiThread(() -> startActivityForResult(call, intent, "recoverAuthResult"));
            } catch (IOException | GoogleAuthException error) {
                call.reject("Google token failed: " + error.getMessage());
            }
        });
    }

    private ArrayList<String> readScopes(PluginCall call) {
        ArrayList<String> scopes = new ArrayList<>();
        JSArray scopeArray = call.getArray("scopes");
        if (scopeArray != null) {
            for (int index = 0; index < scopeArray.length(); index += 1) {
                String scope = scopeArray.optString(index, "");
                if (!scope.isBlank()) scopes.add(scope);
            }
        }
        if (scopes.isEmpty()) scopes.add(DEFAULT_SCOPE);
        return scopes;
    }

    private String buildOAuthScope(ArrayList<String> requestedScopes) {
        StringBuilder builder = new StringBuilder("oauth2:");
        for (String scope : requestedScopes) {
            if (builder.length() > "oauth2:".length()) builder.append(' ');
            builder.append(scope);
        }
        return builder.toString();
    }
}
