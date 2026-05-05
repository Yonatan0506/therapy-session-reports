package com.therapy.sessionreports;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NativeRecorderPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
