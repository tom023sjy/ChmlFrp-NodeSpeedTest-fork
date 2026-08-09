/**
 * 敏感数据加密模块
 *
 * Windows: 使用 DPAPI (CryptProtectData / CryptUnprotectData)，密钥由当前用户账号自动保护
 * 非 Windows: 使用 AES-256-GCM，密钥由机器 ID 派生（fallback 方案）
 *
 * 所有加密/解密均以字节向量为输入输出，调用方负责 Base64 编解码。
 */

use base64::{engine::general_purpose, Engine as _};

/// 加密字符串，返回 Base64 编码的密文
pub fn encrypt_string(plaintext: &str) -> Result<String, String> {
    if plaintext.is_empty() {
        return Ok(String::new());
    }
    let cipher = encrypt_bytes(plaintext.as_bytes())?;
    Ok(general_purpose::STANDARD.encode(&cipher))
}

/// 解密 Base64 编码的密文，返回原始字符串
pub fn decrypt_string(ciphertext_b64: &str) -> Result<String, String> {
    if ciphertext_b64.is_empty() {
        return Ok(String::new());
    }
    let cipher = general_purpose::STANDARD
        .decode(ciphertext_b64)
        .map_err(|e| format!("Base64 解码失败: {}", e))?;
    let plain = decrypt_bytes(&cipher)?;
    String::from_utf8(plain).map_err(|e| format!("UTF-8 解码失败: {}", e))
}

// ===== 平台实现 =====

#[cfg(windows)]
mod platform {
    use windows_sys::Win32::Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
    };

    /// Windows DPAPI 加密
    pub fn encrypt(plaintext: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input_blob = CRYPT_INTEGER_BLOB {
                cbData: plaintext.len() as u32,
                pbData: plaintext.as_ptr() as *mut u8,
            };
            let mut output_blob = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            };
            // description 参数为 null，entropy 为 null（使用默认用户凭据）
            let success = CryptProtectData(
                &input_blob,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                0,
                &mut output_blob,
            );
            if success == 0 {
                return Err(format!("DPAPI CryptProtectData 失败, 错误码: {}", windows_sys::Win32::Foundation::GetLastError()));
            }
            let result = std::slice::from_raw_parts(output_blob.pbData, output_blob.cbData as usize).to_vec();
            // 释放 DPAPI 分配的内存
            windows_sys::Win32::Foundation::LocalFree(output_blob.pbData as *mut _);
            Ok(result)
        }
    }

    /// Windows DPAPI 解密
    pub fn decrypt(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        unsafe {
            let input_blob = CRYPT_INTEGER_BLOB {
                cbData: ciphertext.len() as u32,
                pbData: ciphertext.as_ptr() as *mut u8,
            };
            let mut output_blob = CRYPT_INTEGER_BLOB {
                cbData: 0,
                pbData: std::ptr::null_mut(),
            };
            let mut description: *mut u16 = std::ptr::null_mut();
            let success = CryptUnprotectData(
                &input_blob,
                &mut description,
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null(),
                0,
                &mut output_blob,
            );
            if success == 0 {
                return Err(format!("DPAPI CryptUnprotectData 失败, 错误码: {}", windows_sys::Win32::Foundation::GetLastError()));
            }
            let result = std::slice::from_raw_parts(output_blob.pbData, output_blob.cbData as usize).to_vec();
            windows_sys::Win32::Foundation::LocalFree(output_blob.pbData as *mut _);
            if !description.is_null() {
                windows_sys::Win32::Foundation::LocalFree(description as *mut _);
            }
            Ok(result)
        }
    }
}

#[cfg(not(windows))]
mod platform {
    use aes_gcm::{aead::Aead, Aes256Gcm, KeyInit, Nonce};
    use sha2::{Digest, Sha256};

    /// 从机器 ID 派生 256 位 AES 密钥
    fn derive_key() -> Result<[u8; 32], String> {
        let machine_id = machine_uid::get().map_err(|e| format!("获取机器 ID 失败: {}", e))?;
        let mut hasher = Sha256::new();
        hasher.update(machine_id.as_bytes());
        hasher.update(b"chmlfrp-toolbox-v1"); // 应用级 salt
        let hash = hasher.finalize();
        let mut key = [0u8; 32];
        key.copy_from_slice(&hash);
        Ok(key)
    }

    /// AES-256-GCM 加密
    pub fn encrypt(plaintext: &[u8]) -> Result<Vec<u8>, String> {
        let key = derive_key()?;
        let cipher = Aes256Gcm::new(&key.into());
        // 12 字节 nonce（GCM 推荐长度），前缀存储在密文中
        let nonce_bytes = &key[..12];
        let nonce = Nonce::from_slice(nonce_bytes);
        cipher
            .encrypt(nonce, plaintext)
            .map_err(|e| format!("AES-GCM 加密失败: {}", e))
    }

    /// AES-256-GCM 解密
    pub fn decrypt(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
        let key = derive_key()?;
        let cipher = Aes256Gcm::new(&key.into());
        let nonce_bytes = &key[..12];
        let nonce = Nonce::from_slice(nonce_bytes);
        cipher
            .decrypt(nonce, ciphertext)
            .map_err(|e| format!("AES-GCM 解密失败: {}", e))
    }
}

/// 平台无关的加密入口
pub fn encrypt_bytes(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    platform::encrypt(plaintext)
}

/// 平台无关的解密入口
pub fn decrypt_bytes(ciphertext: &[u8]) -> Result<Vec<u8>, String> {
    platform::decrypt(ciphertext)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_encrypt_decrypt_string() {
        let original = "my-secret-api-key-12345";
        let encrypted = encrypt_string(original).unwrap();
        assert_ne!(encrypted, original);
        let decrypted = decrypt_string(&encrypted).unwrap();
        assert_eq!(decrypted, original);
    }

    #[test]
    fn test_empty_string() {
        let encrypted = encrypt_string("").unwrap();
        assert_eq!(encrypted, "");
        let decrypted = decrypt_string("").unwrap();
        assert_eq!(decrypted, "");
    }
}
