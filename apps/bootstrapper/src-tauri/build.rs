use sha2::{Digest, Sha256};
use std::{env, fs, path::PathBuf};

fn required_release_setting(name: &str) -> String {
    env::var(name).unwrap_or_else(|_| {
        panic!(
            "{name} não foi definido. Use scripts/build-bootstrapper.ps1 ou o workflow de release; um bootstrapper sem canal de distribuição não pode ser publicado."
        )
    })
}

fn prepare_offline_installer() -> bool {
    let output = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR ausente"))
        .join("offline-desktop-installer.exe");
    let source = env::var("LOCAL_DESKTOP_INSTALLER").ok();

    let (bytes, version) = match source {
        Some(source) => {
            let path = PathBuf::from(&source);
            println!("cargo:rerun-if-changed={}", path.display());
            let bytes = fs::read(&path).unwrap_or_else(|error| {
                panic!("não foi possível incorporar {}: {error}", path.display())
            });
            assert!(!bytes.is_empty(), "o instalador desktop local está vazio");
            let version = env::var("LOCAL_DESKTOP_VERSION")
                .unwrap_or_else(|_| env::var("CARGO_PKG_VERSION").expect("versão ausente"));
            (bytes, version)
        }
        None => (Vec::new(), String::new()),
    };

    fs::write(&output, &bytes).expect("falha ao preparar o pacote desktop incorporado");
    println!("cargo:rustc-env=OFFLINE_INSTALLER_SIZE={}", bytes.len());
    println!(
        "cargo:rustc-env=OFFLINE_INSTALLER_SHA256={}",
        hex::encode(Sha256::digest(&bytes))
    );
    println!("cargo:rustc-env=OFFLINE_INSTALLER_VERSION={version}");
    !bytes.is_empty()
}

fn main() {
    println!("cargo:rerun-if-env-changed=RELEASE_MANIFEST_URL");
    println!("cargo:rerun-if-env-changed=INSTALLER_MANIFEST_PUBLIC_KEY");
    println!("cargo:rerun-if-env-changed=LOCAL_DESKTOP_INSTALLER");
    println!("cargo:rerun-if-env-changed=LOCAL_DESKTOP_VERSION");

    let has_offline_installer = prepare_offline_installer();

    if env::var("PROFILE").as_deref() == Ok("release") && !has_offline_installer {
        let url = required_release_setting("RELEASE_MANIFEST_URL");
        let public_key = required_release_setting("INSTALLER_MANIFEST_PUBLIC_KEY");
        assert!(
            url.starts_with("https://") && !url.contains("__"),
            "RELEASE_MANIFEST_URL deve ser uma URL HTTPS real"
        );
        assert!(
            !public_key.contains("__") && public_key.trim().len() >= 43,
            "INSTALLER_MANIFEST_PUBLIC_KEY não contém uma chave Ed25519 válida"
        );
    }

    tauri_build::build()
}
