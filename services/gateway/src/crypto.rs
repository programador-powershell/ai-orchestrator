use aes_gcm::{
    aead::{rand_core::RngCore, Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use anyhow::{anyhow, Context};
use base64::{engine::general_purpose::STANDARD, Engine};

#[derive(Clone)]
pub struct SecretBox(Aes256Gcm);

impl SecretBox {
    pub fn new(key: &[u8; 32]) -> Self {
        Self(Aes256Gcm::new_from_slice(key).expect("32 byte key"))
    }

    pub fn seal(&self, cleartext: &str) -> anyhow::Result<String> {
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let encrypted = self
            .0
            .encrypt(Nonce::from_slice(&nonce), cleartext.as_bytes())
            .map_err(|_| anyhow!("secret encryption failed"))?;
        let mut value = nonce.to_vec();
        value.extend(encrypted);
        Ok(STANDARD.encode(value))
    }

    pub fn open(&self, encoded: &str) -> anyhow::Result<String> {
        let value = STANDARD
            .decode(encoded)
            .context("encrypted secret is not base64")?;
        if value.len() < 13 {
            return Err(anyhow!("encrypted secret is truncated"));
        }
        let cleartext = self
            .0
            .decrypt(Nonce::from_slice(&value[..12]), &value[12..])
            .map_err(|_| anyhow!("secret decryption failed"))?;
        String::from_utf8(cleartext).context("secret is not utf-8")
    }
}

#[cfg(test)]
mod tests {
    use super::SecretBox;

    #[test]
    fn encrypts_roundtrips_and_rejects_tampering() {
        let secrets = SecretBox::new(&[7u8; 32]);
        let encrypted = secrets.seal("provider-secret").expect("encrypt");
        assert_ne!(encrypted, "provider-secret");
        assert_eq!(
            secrets.open(&encrypted).expect("decrypt"),
            "provider-secret"
        );
        let mut bytes =
            base64::Engine::decode(&base64::engine::general_purpose::STANDARD, encrypted)
                .expect("base64");
        *bytes.last_mut().expect("ciphertext") ^= 1;
        let tampered = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes);
        assert!(secrets.open(&tampered).is_err());
    }
}
