//! Isolamento de SO da sandbox — Job Object do Windows.
//!
//! O que existia antes era diretório efêmero + `env_clear` + `kill_on_drop`.
//! Isso NÃO é isolamento: `kill_on_drop` mata só o filho direto (`cmd.exe`),
//! então qualquer neto (`start`, um script que sobe outro processo) sobrevivia
//! ao timeout e continuava rodando com os direitos do usuário.
//!
//! Aqui o processo nasce SUSPENSO, é atribuído a um Job Object e só então é
//! liberado. Nascer suspenso é o que fecha a corrida: sem isso, entre o
//! `spawn` e o `AssignProcessToJobObject` o filho já poderia ter criado um
//! neto fora do job.
//!
//! O job impõe:
//! - `KILL_ON_JOB_CLOSE` — fechar o handle mata a árvore INTEIRA;
//! - teto de processos ativos e de memória por processo;
//! - morte em exceção não tratada (sem caixa de diálogo de crash travando o job);
//! - restrições de UI: sem clipboard, sem handles de janelas de fora, sem
//!   trocar de desktop, sem desligar a máquina.
//!
//! O que isto NÃO faz (e não vamos dizer que faz): não é AppContainer nem
//! contêiner. O processo continua com o TOKEN do usuário — lê e escreve o que
//! o usuário lê e escreve, e alcança a rede. Job Object limita RECURSOS e
//! garante o encerramento da árvore; não reduz privilégio.

#[cfg(windows)]
mod imp {
    use std::io;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    };
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicUIRestrictions,
        JobObjectExtendedLimitInformation, SetInformationJobObject,
        JOBOBJECT_BASIC_UI_RESTRICTIONS, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_ACTIVE_PROCESS, JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, JOB_OBJECT_LIMIT_PROCESS_MEMORY,
        JOB_OBJECT_UILIMIT_DESKTOP, JOB_OBJECT_UILIMIT_EXITWINDOWS,
        JOB_OBJECT_UILIMIT_GLOBALATOMS, JOB_OBJECT_UILIMIT_HANDLES,
        JOB_OBJECT_UILIMIT_READCLIPBOARD, JOB_OBJECT_UILIMIT_WRITECLIPBOARD,
    };
    use windows_sys::Win32::System::Threading::{
        OpenProcess, OpenThread, ResumeThread, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        THREAD_SUSPEND_RESUME,
    };

    /// `CREATE_SUSPENDED | CREATE_NO_WINDOW` — o processo nasce parado e sem
    /// console próprio. Passado ao `Command::creation_flags`.
    pub const CREATION_FLAGS: u32 = 0x0000_0004 | 0x0800_0000;

    /// Teto de processos vivos dentro do job (o `cmd.exe` já conta como 1).
    const MAX_ACTIVE_PROCESSES: u32 = 32;
    /// Teto de memória POR processo do job.
    const MAX_PROCESS_MEMORY_BYTES: usize = 512 * 1024 * 1024;

    /// Handle do job. Fechar (Drop) mata tudo que estiver dentro dele.
    pub struct Jail(HANDLE);

    // SAFETY: HANDLE é um ponteiro opaco do kernel; o handle do job pode ser
    // usado e fechado de qualquer thread.
    unsafe impl Send for Jail {}
    unsafe impl Sync for Jail {}

    impl Drop for Jail {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // KILL_ON_JOB_CLOSE: este close é o que encerra a árvore.
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    impl Jail {
        pub fn new() -> io::Result<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            let jail = Jail(handle);
            jail.apply_limits()?;
            jail.apply_ui_restrictions()?;
            Ok(jail)
        }

        fn apply_limits(&self) -> io::Result<()> {
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
                | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            info.BasicLimitInformation.ActiveProcessLimit = MAX_ACTIVE_PROCESSES;
            info.ProcessMemoryLimit = MAX_PROCESS_MEMORY_BYTES;
            let ok = unsafe {
                SetInformationJobObject(
                    self.0,
                    JobObjectExtendedLimitInformation,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        fn apply_ui_restrictions(&self) -> io::Result<()> {
            let info = JOBOBJECT_BASIC_UI_RESTRICTIONS {
                UIRestrictionsClass: JOB_OBJECT_UILIMIT_HANDLES
                    | JOB_OBJECT_UILIMIT_READCLIPBOARD
                    | JOB_OBJECT_UILIMIT_WRITECLIPBOARD
                    | JOB_OBJECT_UILIMIT_GLOBALATOMS
                    | JOB_OBJECT_UILIMIT_DESKTOP
                    | JOB_OBJECT_UILIMIT_EXITWINDOWS,
            };
            let ok = unsafe {
                SetInformationJobObject(
                    self.0,
                    JobObjectBasicUIRestrictions,
                    &info as *const _ as *const _,
                    std::mem::size_of::<JOBOBJECT_BASIC_UI_RESTRICTIONS>() as u32,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        /// Prende o processo (ainda suspenso) ao job e o libera para rodar.
        /// A ordem importa: atribuir DEPOIS de resumir deixaria a corrida aberta.
        ///
        /// Abre o processo pelo PID em vez de receber o handle do `Child`: o
        /// `tokio::process::Child` não expõe um `AsRawHandle`. Não há risco de
        /// reúso de PID porque o chamador segura o `Child` vivo e suspenso.
        pub fn capture_and_resume(&self, pid: u32) -> io::Result<()> {
            let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
            if process.is_null() {
                return Err(io::Error::last_os_error());
            }
            let assigned = unsafe { AssignProcessToJobObject(self.0, process) };
            unsafe { CloseHandle(process) };
            if assigned == 0 {
                return Err(io::Error::last_os_error());
            }
            resume_process_threads(pid)
        }
    }

    /// Retoma todas as threads do processo. `CREATE_SUSPENDED` deixa a thread
    /// principal parada, e o `tokio::process::Child` não expõe o handle dela —
    /// então varremos as threads do PID pelo snapshot do ToolHelp.
    fn resume_process_threads(pid: u32) -> io::Result<()> {
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }
        let mut entry: THREADENTRY32 = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        let mut resumed = 0usize;
        let mut ok = unsafe { Thread32First(snapshot, &mut entry) };
        while ok != 0 {
            if entry.th32OwnerProcessID == pid {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if !thread.is_null() {
                    unsafe { ResumeThread(thread) };
                    unsafe { CloseHandle(thread) };
                    resumed += 1;
                }
            }
            entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
            ok = unsafe { Thread32Next(snapshot, &mut entry) };
        }
        unsafe { CloseHandle(snapshot) };
        if resumed == 0 {
            // Nenhuma thread retomada = processo suspenso para sempre. Melhor
            // falhar alto do que devolver um timeout enganoso.
            return Err(io::Error::other(
                "nenhuma thread do processo da sandbox pôde ser retomada",
            ));
        }
        Ok(())
    }

}

#[cfg(not(windows))]
mod imp {
    use std::io;

    /// Sem Job Object fora do Windows: só o "sem janela" não faz sentido aqui.
    pub const CREATION_FLAGS: u32 = 0;

    pub struct Jail;

    impl Jail {
        pub fn new() -> io::Result<Self> {
            Ok(Jail)
        }
        pub fn capture_and_resume(&self, _pid: u32) -> io::Result<()> {
            Ok(())
        }
    }
}

pub use imp::{Jail, CREATION_FLAGS};

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::os::windows::process::CommandExt;
    use std::process::{Command, Stdio};
    use std::thread::sleep;
    use std::time::Duration;

    /// Conta processos vivos com o nome dado.
    ///
    /// Sem `/FI`: as aspas do filtro nao sobrevivem ao escaping de
    /// `cmd /S /C`, e o filtro passava a nunca casar. Filtrar em Rust e
    /// equivalente e nao depende de como o cmd interpreta aspas.
    fn conta(nome: &str) -> usize {
        let out = Command::new("cmd.exe")
            .args(["/D", "/S", "/C", "tasklist /NH"])
            .creation_flags(0x0800_0000)
            .output()
            .expect("tasklist");
        let alvo = nome.to_lowercase();
        String::from_utf8_lossy(&out.stdout)
            .lines()
            .filter(|line| line.to_lowercase().starts_with(&alvo))
            .count()
    }

    #[test]
    fn cria_job_com_limites() {
        // Se qualquer SetInformationJobObject falhasse, new() devolveria erro.
        assert!(Jail::new().is_ok());
    }

    /// O ponto da mudança: matar a ÁRVORE, não só o filho direto.
    ///
    /// `cmd /c start ping` faz o cmd.exe TERMINAR e deixar um ping órfão. Com
    /// `kill_on_drop` sozinho esse ping sobreviveria; com o job, fechar o
    /// handle leva o neto junto.
    #[test]
    fn fechar_o_job_mata_o_neto_orfao() {
        let antes = conta("PING.EXE");
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/S", "/C", "start /B ping -n 30 127.0.0.1"])
            .creation_flags(CREATION_FLAGS)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn");
        let pid = child.id();
        let jail = Jail::new().expect("job");
        jail.capture_and_resume(pid).expect("captura");
        // Espera o cmd.exe morrer deixando o ping para trás.
        let _ = child.wait();
        sleep(Duration::from_millis(700));
        let durante = conta("PING.EXE");
        assert!(
            durante > antes,
            "o neto órfão deveria estar vivo antes do job fechar (antes={antes}, durante={durante})"
        );

        drop(jail); // KILL_ON_JOB_CLOSE
        sleep(Duration::from_millis(700));
        let depois = conta("PING.EXE");
        assert_eq!(
            depois, antes,
            "fechar o job tem de matar o neto (antes={antes}, depois={depois})"
        );
    }

    /// CREATE_SUSPENDED sem resume seria um processo travado para sempre —
    /// garante que o resume das threads realmente destrava.
    #[test]
    fn processo_suspenso_e_retomado_roda_ate_o_fim() {
        let mut child = Command::new("cmd.exe")
            .args(["/D", "/S", "/C", "exit 7"])
            .creation_flags(CREATION_FLAGS)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn");
        let jail = Jail::new().expect("job");
        jail.capture_and_resume(child.id()).expect("captura");
        let status = child.wait().expect("wait");
        assert_eq!(status.code(), Some(7));
    }
}
