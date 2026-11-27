package com.moci.cet6;

import android.content.Context;
import android.content.SharedPreferences;

/** Small allow-listed preference store. Never used for word data. */
final class Prefs {
    private final SharedPreferences sp;

    Prefs(Context ctx) {
        this.sp = ctx.getSharedPreferences("moci_prefs", Context.MODE_PRIVATE);
    }

    String get(String key, String def) {
        return sp.getString(key, def);
    }

    boolean getBool(String key, boolean def) {
        return sp.getBoolean(key, def);
    }

    int getInt(String key, int def) {
        return sp.getInt(key, def);
    }

    void set(String key, String value) {
        SharedPreferences.Editor e = sp.edit();
        if (value == null) e.remove(key);
        else e.putString(key, value);
        e.apply();
    }

    void setBool(String key, boolean value) {
        sp.edit().putBoolean(key, value).apply();
    }

    void setInt(String key, int value) {
        sp.edit().putInt(key, value).apply();
    }
}
