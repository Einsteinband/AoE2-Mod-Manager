//! 会话 Cookie 的本地缓存（Windows DPAPI 加密）。
//!
//! 为什么需要它：`AgeAuthSession` 是 **session cookie（无 Expires）**，WebView2 退出
//! 进程后不会保留，因此"保留数据目录"只能救 SSO 持久 Cookie，不能保证免登录。
//! 这里用当前 Windows 用户凭据（DPAPI，CryptProtectData）加密后落盘，
//! 只有同一用户在同一台机器上才能解出明文；文件被复制到别处无法解密。

use std::fs;
use std::path::Path;

#[cfg(windows)]
pub fn protect(plain: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: plain.len() as u32,
        pbData: plain.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

    let ok = unsafe {
        CryptProtectData(
            &input as *const CRYPT_INTEGER_BLOB,
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!("DPAPI 加密失败：{}", std::io::Error::last_os_error()));
    }

    let bytes = if output.pbData.is_null() || output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() }
    };
    if !output.pbData.is_null() {
        unsafe {
            LocalFree(output.pbData as *mut std::ffi::c_void);
        }
    }
    if bytes.is_empty() {
        return Err("DPAPI 返回了空数据".to_string());
    }
    Ok(bytes)
}

#[cfg(windows)]
pub fn unprotect(blob: &[u8]) -> Result<Vec<u8>, String> {
    use windows_sys::Win32::Foundation::LocalFree;
    use windows_sys::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    if blob.is_empty() {
        return Err("缓存内容为空".to_string());
    }

    let input = CRYPT_INTEGER_BLOB {
        cbData: blob.len() as u32,
        pbData: blob.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: std::ptr::null_mut() };

    let ok = unsafe {
        CryptUnprotectData(
            &input as *const CRYPT_INTEGER_BLOB,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
            std::ptr::null(),
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
    };
    if ok == 0 {
        return Err(format!("DPAPI 解密失败：{}", std::io::Error::last_os_error()));
    }

    let bytes = if output.pbData.is_null() || output.cbData == 0 {
        Vec::new()
    } else {
        unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() }
    };
    if !output.pbData.is_null() {
        unsafe {
            LocalFree(output.pbData as *mut std::ffi::c_void);
        }
    }
    Ok(bytes)
}

#[cfg(not(windows))]
pub fn protect(_plain: &[u8]) -> Result<Vec<u8>, String> {
    Err("会话缓存加密仅支持 Windows".to_string())
}

#[cfg(not(windows))]
pub fn unprotect(_blob: &[u8]) -> Result<Vec<u8>, String> {
    Err("会话缓存加密仅支持 Windows".to_string())
}

/// 加密写入；调用方负责传入已经拼好的 Cookie 头
pub fn save(path: &Path, header: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("无法创建缓存目录：{e}"))?;
    }
    let blob = protect(header.as_bytes())?;
    fs::write(path, blob).map_err(|e| format!("写入会话缓存失败：{e}"))
}

/// 读取缓存；解密失败（换用户/换机器/文件损坏）时删除并返回 None，不阻断流程
pub fn load(path: &Path) -> Option<String> {
    let blob = fs::read(path).ok()?;
    match unprotect(&blob) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) if !text.trim().is_empty() => Some(text),
            Ok(_) => None,
            Err(e) => {
                log::warn!(target: "session-cache", "会话缓存不是有效文本（{e}），已删除");
                let _ = fs::remove_file(path);
                None
            }
        },
        Err(e) => {
            log::warn!(target: "session-cache", "会话缓存无法解密（{e}），已删除");
            let _ = fs::remove_file(path);
            None
        }
    }
}

/// 删除缓存（"退出登录"时调用）
pub fn clear(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("删除会话缓存失败：{e}")),
    }
}
