package com.moci.cet6;

import android.content.Context;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.List;

/** File storage inside the app private dir with atomic writes and a strict path sandbox. */
final class AtomicStore {
    private final File root;

    AtomicStore(Context ctx) {
        this.root = ctx.getFilesDir();
    }

    File root() {
        return root;
    }

    File resolve(String rel) throws IOException {
        if (rel == null) throw new IOException("empty path");
        String p = rel.replace('\\', '/').trim();
        while (p.startsWith("/")) p = p.substring(1);
        if (p.isEmpty()) throw new IOException("empty path");
        if (p.contains("..")) throw new IOException("illegal path");
        if (p.length() > 240) throw new IOException("path too long");
        if (!p.matches("[A-Za-z0-9._/-]+")) throw new IOException("illegal characters");
        File f = new File(root, p);
        String rootCanon = root.getCanonicalPath();
        String fileCanon = f.getCanonicalPath();
        if (!fileCanon.equals(rootCanon) && !fileCanon.startsWith(rootCanon + File.separator)) {
            throw new IOException("outside sandbox");
        }
        return f;
    }

    String readText(String rel) throws IOException {
        File f = resolve(rel);
        if (!f.exists()) return null;
        byte[] buf = readAll(f);
        return new String(buf, StandardCharsets.UTF_8);
    }

    String readBase64(String rel) throws IOException {
        File f = resolve(rel);
        if (!f.exists()) return null;
        return Base64.encodeToString(readAll(f), Base64.NO_WRAP);
    }

    long writeText(String rel, String text) throws IOException {
        byte[] data = (text == null ? "" : text).getBytes(StandardCharsets.UTF_8);
        writeBytes(rel, data);
        return data.length;
    }

    long writeBase64(String rel, String b64) throws IOException {
        byte[] data = Base64.decode(b64, Base64.DEFAULT);
        writeBytes(rel, data);
        return data.length;
    }

    /** Writes to a sibling .tmp file, fsyncs, keeps a .prev copy, then renames atomically. */
    void writeBytes(String rel, byte[] data) throws IOException {
        File target = resolve(rel);
        File dir = target.getParentFile();
        if (dir != null && !dir.exists() && !dir.mkdirs()) throw new IOException("mkdir failed");
        File tmp = new File(dir, target.getName() + ".tmp-" + Long.toHexString(System.nanoTime()));
        FileOutputStream out = null;
        try {
            out = new FileOutputStream(tmp);
            out.write(data);
            out.flush();
            out.getFD().sync();
        } finally {
            if (out != null) try { out.close(); } catch (IOException ignored) { }
        }
        if (target.exists()) {
            File prev = new File(dir, target.getName() + ".prev");
            if (prev.exists() && !prev.delete()) { /* best effort */ }
            if (!target.renameTo(prev)) { /* keep going, rename below may replace */ }
        }
        if (!tmp.renameTo(target)) {
            // Some file systems refuse replace; fall back to copy + delete.
            copyFile(tmp, target);
            if (!tmp.delete()) { /* best effort */ }
        }
    }

    private static void copyFile(File src, File dst) throws IOException {
        FileInputStream in = null;
        FileOutputStream out = null;
        try {
            in = new FileInputStream(src);
            out = new FileOutputStream(dst);
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            out.flush();
            out.getFD().sync();
        } finally {
            if (in != null) try { in.close(); } catch (IOException ignored) { }
            if (out != null) try { out.close(); } catch (IOException ignored) { }
        }
    }

    private static byte[] readAll(File f) throws IOException {
        if (f.length() > 64L * 1024 * 1024) throw new IOException("file too large");
        FileInputStream in = new FileInputStream(f);
        try {
            byte[] data = new byte[(int) f.length()];
            int off = 0;
            while (off < data.length) {
                int n = in.read(data, off, data.length - off);
                if (n < 0) break;
                off += n;
            }
            if (off == data.length) return data;
            return Arrays.copyOf(data, off);
        } finally {
            in.close();
        }
    }

    boolean delete(String rel) throws IOException {
        File f = resolve(rel);
        if (!f.exists()) return true;
        return deleteTree(f);
    }

    private static boolean deleteTree(File f) {
        if (f.isDirectory()) {
            File[] kids = f.listFiles();
            if (kids != null) for (File k : kids) deleteTree(k);
        }
        return f.delete();
    }

    JSONArray list(String rel) throws IOException {
        // An empty path means "the storage root" here, so the self-test can prove
        // directory listing works without inventing a temporary subdirectory.
        // resolve() rejects "" by design (every other operation needs a real file),
        // so the root is substituted before validation.
        File dir = (rel == null || rel.trim().isEmpty()) ? root : resolve(rel);
        JSONArray arr = new JSONArray();
        File[] kids = dir.listFiles();
        if (kids == null) return arr;
        List<File> files = new ArrayList<>(Arrays.asList(kids));
        files.sort(Comparator.comparing(File::getName));
        for (File f : files) {
            if (f.getName().endsWith(".tmp-") || f.getName().contains(".tmp-")) continue;
            JSONObject o = new JSONObject();
            try {
                o.put("name", f.getName());
                o.put("size", f.isDirectory() ? 0 : f.length());
                o.put("dir", f.isDirectory());
                o.put("mtime", f.lastModified());
            } catch (Exception ignored) { }
            arr.put(o);
        }
        return arr;
    }

    JSONObject stat(String rel) throws IOException {
        File f = resolve(rel);
        JSONObject o = new JSONObject();
        try {
            o.put("exists", f.exists());
            o.put("size", f.exists() && f.isFile() ? f.length() : 0);
            o.put("dir", f.isDirectory());
            o.put("mtime", f.exists() ? f.lastModified() : 0);
        } catch (Exception ignored) { }
        return o;
    }

    JSONObject storageInfo() throws IOException {
        JSONObject o = new JSONObject();
        try {
            o.put("filesDir", root.getAbsolutePath());
            o.put("freeBytes", root.getUsableSpace());
            o.put("totalBytes", root.getTotalSpace());
        } catch (Exception ignored) { }
        return o;
    }
}
