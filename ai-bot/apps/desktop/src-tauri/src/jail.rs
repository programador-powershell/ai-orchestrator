//! Isolamento de processo da sandbox — Job Object do Windows.
//!
//! # Por que Job Object e não `kill_on_drop`
//!
//! `kill_on_drop` (e qualquer `child.kill()`) mata **só o filho direto**. Um
//! `cmd.exe` que roda `start /B ping` TERMINA sozinho e deixa o `ping` vivo:
//! o neto perdeu o pai, virou órfão do sistema e continua rodando com todos os
//! direitos da pessoa, muito depois do timeout da sandbox ter "encerrado" a
//! tarefa. A UI diria "processo encerrado" enquanto o neto segue lá.
//!
//! `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` é o que resolve isso, e é a razão de
//! este arquivo existir. Todo processo criado por alguém de dentro do job
//! nasce dentro do job — filho, neto, bisneto. Fechar o handle do job (o
//! `Drop` do [`Jail`]) mata a **árvore inteira** de uma vez, sem precisar
//! descobrir quem gerou quem. É a única garantia de encerramento que não tem
//! buraco.
//!
//! # A ordem importa: nascer SUSPENSO
//!
//! O processo é criado com `CREATE_SUSPENDED`, atribuído ao job, e **só então**
//! tem as threads retomadas. Sem isso existe uma corrida real: entre o `spawn`
//! e o `AssignProcessToJobObject` o filho já teria rodado, e um neto criado
//! nessa janela nasceria FORA do job — sobrevivendo exatamente ao mecanismo que
//! deveria matá-lo. Suspenso, o processo não executa uma instrução sequer antes
//! de estar preso.
//!
//! Falhar ao criar o job é ERRO, não degradação: rodar sem isolamento com a
//! interface dizendo "isolado" é mentir para quem aprovou a execução.
//!
//! # O que isto NÃO faz (e não vamos dizer que faz)
//!
//! Não é AppContainer nem contêiner. O processo continua com o **token do
//! usuário** — lê e escreve o que o usuário lê e escreve, e alcança a rede. Job
//! Object limita RECURSOS e garante o encerramento da árvore; não reduz
//! privilégio.
//!
//! # Por que FFI declarada à mão
//!
//! São dez símbolos do `kernel32`. Trazer `windows-sys` ou `winapi` para isso
//! seria uma dependência nova inteira — e neste projeto dependência é
//! homologada uma a uma pela TI/SI. As declarações abaixo estão escritas contra
//! a documentação da Microsoft; os `#[repr(C)]` reproduzem o layout exato das
//! structs, inclusive campos que não usamos (removê-los desalinharia o resto).

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use std::io;

    /* ------------------------- tipos do Win32 ------------------------- */
    // Apelidos locais para os tipos da documentação da Microsoft, para as
    // assinaturas abaixo poderem ser conferidas linha a linha contra o MSDN.

    /// `HANDLE` — ponteiro opaco do kernel.
    type Handle = *mut c_void;
    /// `BOOL` — inteiro de 32 bits; 0 é falha.
    type Bool32 = i32;

    /// `INVALID_HANDLE_VALUE`. Atenção: é `-1`, e NÃO nulo. Só
    /// `CreateToolhelp32Snapshot` devolve este valor em caso de erro;
    /// `CreateJobObjectW`, `OpenProcess` e `OpenThread` devolvem nulo. Tratar
    /// os dois casos com a mesma comparação deixaria passar uma falha.
    const INVALID_HANDLE_VALUE: Handle = -1isize as Handle;

    /* --------------------- classes de informação ---------------------- */
    // Valores da enum JOBOBJECTINFOCLASS.

    /// `JobObjectBasicUIRestrictions`
    const JOB_OBJECT_INFO_BASIC_UI_RESTRICTIONS: i32 = 4;
    /// `JobObjectExtendedLimitInformation`
    const JOB_OBJECT_INFO_EXTENDED_LIMIT: i32 = 9;

    /* --------------------------- limit flags -------------------------- */

    /// **O que importa.** Fechar o handle do job mata a árvore inteira.
    const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE: u32 = 0x0000_2000;
    const JOB_OBJECT_LIMIT_ACTIVE_PROCESS: u32 = 0x0000_0008;
    const JOB_OBJECT_LIMIT_PROCESS_MEMORY: u32 = 0x0000_0100;
    /// Sem isto, uma exceção não tratada abre caixa de diálogo de crash e o
    /// processo fica pendurado esperando alguém clicar "OK".
    const JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION: u32 = 0x0000_0400;

    /* ------------------------ restrições de UI ------------------------ */

    const JOB_OBJECT_UILIMIT_HANDLES: u32 = 0x0000_0001;
    const JOB_OBJECT_UILIMIT_READCLIPBOARD: u32 = 0x0000_0002;
    const JOB_OBJECT_UILIMIT_WRITECLIPBOARD: u32 = 0x0000_0004;
    const JOB_OBJECT_UILIMIT_GLOBALATOMS: u32 = 0x0000_0020;
    const JOB_OBJECT_UILIMIT_DESKTOP: u32 = 0x0000_0040;
    const JOB_OBJECT_UILIMIT_EXITWINDOWS: u32 = 0x0000_0080;

    /* --------------------------- direitos ----------------------------- */

    const PROCESS_TERMINATE: u32 = 0x0001;
    const PROCESS_SET_QUOTA: u32 = 0x0100;
    const THREAD_SUSPEND_RESUME: u32 = 0x0002;
    const TH32CS_SNAPTHREAD: u32 = 0x0000_0004;

    /// Retorno de erro de `ResumeThread` (`(DWORD) -1`).
    const RESUME_THREAD_FAILED: u32 = u32::MAX;

    /* ---------------------------- structs ----------------------------- */

    /// `JOBOBJECT_BASIC_LIMIT_INFORMATION`. 64 bytes em x64.
    ///
    /// Os campos que não usamos ficam aqui porque o layout é posicional: tirar
    /// um só deslocaria todos os seguintes e o kernel leria lixo.
    #[repr(C)]
    // `dead_code`: os campos existem para o LAYOUT, não para serem lidos daqui.
    // Quem lê a maior parte deles é o kernel.
    #[allow(non_snake_case, dead_code)]
    #[derive(Clone, Copy)]
    pub(super) struct BasicLimitInformation {
        PerProcessUserTimeLimit: i64,
        PerJobUserTimeLimit: i64,
        LimitFlags: u32,
        MinimumWorkingSetSize: usize,
        MaximumWorkingSetSize: usize,
        ActiveProcessLimit: u32,
        Affinity: usize,
        PriorityClass: u32,
        SchedulingClass: u32,
    }

    /// `IO_COUNTERS`. 48 bytes.
    #[repr(C)]
    #[allow(non_snake_case, dead_code)]
    #[derive(Clone, Copy)]
    pub(super) struct IoCounters {
        ReadOperationCount: u64,
        WriteOperationCount: u64,
        OtherOperationCount: u64,
        ReadTransferCount: u64,
        WriteTransferCount: u64,
        OtherTransferCount: u64,
    }

    /// `JOBOBJECT_EXTENDED_LIMIT_INFORMATION`. 144 bytes em x64.
    #[repr(C)]
    #[allow(non_snake_case, dead_code)]
    #[derive(Clone, Copy)]
    pub(super) struct ExtendedLimitInformation {
        BasicLimitInformation: BasicLimitInformation,
        IoInfo: IoCounters,
        ProcessMemoryLimit: usize,
        JobMemoryLimit: usize,
        PeakProcessMemoryUsed: usize,
        PeakJobMemoryUsed: usize,
    }

    /// `JOBOBJECT_BASIC_UI_RESTRICTIONS`.
    #[repr(C)]
    #[allow(non_snake_case, dead_code)]
    #[derive(Clone, Copy)]
    pub(super) struct BasicUiRestrictions {
        UIRestrictionsClass: u32,
    }

    /// `THREADENTRY32`. 28 bytes.
    ///
    /// `dwSize` precisa estar preenchido ANTES da chamada, senão
    /// `Thread32First` recusa com ERROR_INVALID_PARAMETER.
    #[repr(C)]
    #[allow(non_snake_case, dead_code)]
    #[derive(Clone, Copy)]
    pub(super) struct ThreadEntry32 {
        dwSize: u32,
        cntUsage: u32,
        th32ThreadID: u32,
        th32OwnerProcessID: u32,
        tpBasePri: i32,
        tpDeltaPri: i32,
        dwFlags: u32,
    }

    /* ------------------------- as dez chamadas ------------------------ */

    #[link(name = "kernel32")]
    #[allow(non_snake_case)]
    extern "system" {
        fn CreateJobObjectW(job_attributes: *const c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            info_class: i32,
            info: *const c_void,
            info_len: u32,
        ) -> Bool32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> Bool32;
        /// Não estava na lista original da tarefa, mas é obrigatória:
        /// `AssignProcessToJobObject` recebe um HANDLE, e o que temos é um PID
        /// (o `Child` do tokio não expõe o handle). Sem `OpenProcess` não há
        /// como transformar um no outro.
        fn OpenProcess(desired_access: u32, inherit_handle: Bool32, pid: u32) -> Handle;
        fn OpenThread(desired_access: u32, inherit_handle: Bool32, thread_id: u32) -> Handle;
        fn ResumeThread(thread: Handle) -> u32;
        fn CreateToolhelp32Snapshot(flags: u32, pid: u32) -> Handle;
        fn Thread32First(snapshot: Handle, entry: *mut ThreadEntry32) -> Bool32;
        fn Thread32Next(snapshot: Handle, entry: *mut ThreadEntry32) -> Bool32;
        fn CloseHandle(object: Handle) -> Bool32;
    }

    /* ----------------------------- política --------------------------- */

    /// `CREATE_SUSPENDED | CREATE_NO_WINDOW` — o processo nasce parado e sem
    /// console próprio. Vai em `Command::creation_flags`.
    ///
    /// `CREATE_SUSPENDED` não é otimização: é o que fecha a corrida descrita no
    /// cabeçalho. Quem criar o processo sem esta constante e depois chamar
    /// [`Jail::capture_and_resume`] terá um isolamento com buraco.
    pub const CREATION_FLAGS: u32 = 0x0000_0004 | 0x0800_0000;

    /// Teto de processos vivos dentro do job (o `cmd.exe` já conta como 1).
    const MAX_ACTIVE_PROCESSES: u32 = 32;
    /// Teto de memória POR processo do job.
    const MAX_PROCESS_MEMORY_BYTES: usize = 512 * 1024 * 1024;

    /* ------------------------------- Jail ----------------------------- */

    /// Handle do job. **Fechar (o `Drop`) mata tudo que estiver dentro.**
    ///
    /// Guardar este valor vivo é o que mantém a sandbox aberta; soltá-lo é o
    /// encerramento. Não existe "esquecer" o `Jail` sem matar a árvore, e é
    /// exatamente esse o desenho.
    pub struct Jail(Handle);

    // SAFETY: HANDLE é um ponteiro opaco do kernel, não uma referência a
    // memória do processo. O handle do job pode ser usado e fechado de
    // qualquer thread — o kernel serializa por conta própria.
    unsafe impl Send for Jail {}
    unsafe impl Sync for Jail {}

    impl Drop for Jail {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // KILL_ON_JOB_CLOSE: ESTE close é o que encerra a árvore.
                unsafe { CloseHandle(self.0) };
            }
        }
    }

    impl Jail {
        /// Cria o job já com os limites aplicados.
        ///
        /// Devolver erro aqui tem de abortar a execução do chamador: seguir sem
        /// job seria rodar sem isolamento com a interface dizendo "isolado".
        pub fn new() -> io::Result<Self> {
            // Job anônimo (sem nome): ninguém de fora do processo pode abri-lo
            // pelo nome e injetar coisas dentro.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                return Err(io::Error::last_os_error());
            }
            // A partir daqui o handle está sob RAII: qualquer `?` abaixo fecha
            // o job pelo Drop em vez de vazar o handle.
            let jail = Jail(handle);
            jail.apply_limits()?;
            jail.apply_ui_restrictions()?;
            Ok(jail)
        }

        fn apply_limits(&self) -> io::Result<()> {
            // SAFETY: `zeroed` é o estado válido inicial desta struct — todos os
            // campos são inteiros e o kernel só lê os que as flags apontam.
            let mut info: ExtendedLimitInformation = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
                | JOB_OBJECT_LIMIT_ACTIVE_PROCESS
                | JOB_OBJECT_LIMIT_PROCESS_MEMORY;
            info.BasicLimitInformation.ActiveProcessLimit = MAX_ACTIVE_PROCESSES;
            info.ProcessMemoryLimit = MAX_PROCESS_MEMORY_BYTES;

            let ok = unsafe {
                SetInformationJobObject(
                    self.0,
                    JOB_OBJECT_INFO_EXTENDED_LIMIT,
                    &info as *const ExtendedLimitInformation as *const c_void,
                    std::mem::size_of::<ExtendedLimitInformation>() as u32,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        /// Restrições de UI: sem clipboard, sem alcançar janelas de fora, sem
        /// trocar de desktop, sem desligar a máquina. Um processo de sandbox não
        /// tem por que fazer nada disso, e ler o clipboard seria vazamento de
        /// dado que a pessoa nem sabe que está exposto.
        fn apply_ui_restrictions(&self) -> io::Result<()> {
            let info = BasicUiRestrictions {
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
                    JOB_OBJECT_INFO_BASIC_UI_RESTRICTIONS,
                    &info as *const BasicUiRestrictions as *const c_void,
                    std::mem::size_of::<BasicUiRestrictions>() as u32,
                )
            };
            if ok == 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        }

        /// Prende o processo (ainda SUSPENSO) ao job e só então o libera.
        ///
        /// A ordem é o ponto todo: atribuir DEPOIS de retomar deixaria aberta a
        /// janela em que um neto nasce fora do job.
        ///
        /// Recebe PID em vez de handle porque o `tokio::process::Child` não
        /// expõe `AsRawHandle`. Não há risco de reúso de PID: o chamador segura
        /// o `Child` vivo e suspenso, então o PID não pode ter sido reciclado
        /// para outro processo enquanto esta função roda.
        pub fn capture_and_resume(&self, pid: u32) -> io::Result<()> {
            // PROCESS_SET_QUOTA + PROCESS_TERMINATE são exatamente os direitos
            // que AssignProcessToJobObject exige — nada além disso.
            let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
            if process.is_null() {
                return Err(io::Error::last_os_error());
            }
            let assigned = unsafe { AssignProcessToJobObject(self.0, process) };
            // Fecha o handle do processo em qualquer caso: o job já guarda a
            // referência de que precisa, e vazar handle aqui seguraria o objeto
            // do processo vivo depois que ele morresse.
            let erro = if assigned == 0 {
                Some(io::Error::last_os_error())
            } else {
                None
            };
            unsafe { CloseHandle(process) };
            if let Some(erro) = erro {
                return Err(erro);
            }

            resume_process_threads(pid)
        }
    }

    /// Retoma todas as threads do processo.
    ///
    /// `CREATE_SUSPENDED` deixa a thread principal parada e o
    /// `tokio::process::Child` não expõe o handle dela — não existe API que dê
    /// "a thread principal do PID X". A saída é varrer o snapshot de TODAS as
    /// threads do sistema pelo ToolHelp e retomar as que pertencem a este PID.
    /// Feio, mas é o caminho documentado.
    fn resume_process_threads(pid: u32) -> io::Result<()> {
        // O parâmetro de PID é ignorado para TH32CS_SNAPTHREAD: o snapshot é
        // sempre do sistema inteiro. Por isso o filtro por th32OwnerProcessID
        // abaixo é obrigatório — sem ele retomaríamos threads de terceiros.
        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) };
        if snapshot == INVALID_HANDLE_VALUE {
            return Err(io::Error::last_os_error());
        }

        // SAFETY: struct de inteiros; `dwSize` é preenchido logo abaixo, que é
        // o único campo que a API exige na entrada.
        let mut entry: ThreadEntry32 = unsafe { std::mem::zeroed() };
        entry.dwSize = std::mem::size_of::<ThreadEntry32>() as u32;

        let mut resumed = 0usize;
        let mut ok = unsafe { Thread32First(snapshot, &mut entry) };
        while ok != 0 {
            if entry.th32OwnerProcessID == pid {
                let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, 0, entry.th32ThreadID) };
                if !thread.is_null() {
                    // Thread criada com CREATE_SUSPENDED tem contador de
                    // suspensão 1, então um ResumeThread basta.
                    let anterior = unsafe { ResumeThread(thread) };
                    unsafe { CloseHandle(thread) };
                    if anterior != RESUME_THREAD_FAILED {
                        resumed += 1;
                    }
                }
            }
            entry.dwSize = std::mem::size_of::<ThreadEntry32>() as u32;
            ok = unsafe { Thread32Next(snapshot, &mut entry) };
        }
        unsafe { CloseHandle(snapshot) };

        if resumed == 0 {
            // Nenhuma thread retomada = processo suspenso para sempre, que a
            // camada de cima veria como um timeout misterioso. Falhar alto aqui
            // é melhor do que devolver um timeout enganoso meio minuto depois.
            return Err(io::Error::other(
                "nenhuma thread do processo da sandbox pôde ser retomada",
            ));
        }
        Ok(())
    }
}

#[cfg(not(windows))]
mod imp {
    //! Mesma API, sem isolamento nenhum.
    //!
    //! **NÃO EXISTE ISOLAMENTO NESTA PLATAFORMA.** Não há Job Object fora do
    //! Windows, e um equivalente de verdade (cgroups + namespaces no Linux,
    //! sandbox-exec no macOS) é outro trabalho, não um detalhe deste arquivo.
    //!
    //! Consequência para quem chama: **a interface NÃO pode dizer "isolado"
    //! aqui.** O `Jail` compila e devolve `Ok`, então nada quebra — mas o
    //! processo roda solto, e o neto órfão que o `KILL_ON_JOB_CLOSE` mataria no
    //! Windows sobrevive normalmente. Rotular isso de "isolado" na tela seria
    //! mentir para quem aprovou a execução com base nesse rótulo. Enquanto o
    //! equivalente não existir, o rótulo correto é "sem isolamento".

    use std::io;

    /// Não há `CREATE_SUSPENDED` nem `CREATE_NO_WINDOW` fora do Windows; os
    /// dois são conceitos da `CreateProcess`.
    pub const CREATION_FLAGS: u32 = 0;

    pub struct Jail;

    impl Jail {
        pub fn new() -> io::Result<Self> {
            Ok(Jail)
        }

        /// No-op: não há job a que atribuir, e o processo não nasceu suspenso
        /// (CREATION_FLAGS é 0), então não há o que retomar.
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
    /// Sem `/FI`: as aspas do filtro não sobrevivem ao escaping de `cmd /S /C`,
    /// e o filtro passaria a nunca casar (dando um teste que "passa" sempre).
    /// Filtrar em Rust é equivalente e não depende de como o cmd lê aspas.
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

    /// Layout das structs de FFI, conferido contra a documentação da Microsoft.
    ///
    /// Vale mais do que parece: `SetInformationJobObject` valida o tamanho que
    /// passamos, então um campo com o tipo errado (um `u32` onde a API espera
    /// `SIZE_T`, por exemplo) não daria erro de compilação — daria
    /// `ERROR_BAD_LENGTH` em produção, ou pior, o kernel lendo os campos
    /// deslocados. Aqui isso vira uma falha de teste com o número na tela.
    #[test]
    #[cfg(target_pointer_width = "64")]
    fn layout_das_structs_bate_com_o_win32() {
        use std::mem::size_of;
        assert_eq!(size_of::<super::imp::ExtendedLimitInformation>(), 144);
        assert_eq!(size_of::<super::imp::BasicUiRestrictions>(), 4);
        assert_eq!(size_of::<super::imp::ThreadEntry32>(), 28);
    }

    #[test]
    fn cria_job_com_limites() {
        // Se qualquer SetInformationJobObject falhasse — layout de struct
        // errado, tamanho errado, classe errada — new() devolveria erro. Este
        // teste é a conferência de que a FFI escrita à mão está certa.
        assert!(Jail::new().is_ok());
    }

    /// O ponto da existência deste arquivo: matar a ÁRVORE, não só o filho.
    ///
    /// `cmd /c start /B ping` faz o `cmd.exe` TERMINAR deixando um `ping`
    /// órfão. Com `kill_on_drop` sozinho esse ping sobreviveria; com o job,
    /// fechar o handle leva o neto junto.
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
            "o neto órfão deveria estar vivo ANTES do job fechar \
             (antes={antes}, durante={durante}) — sem isso o teste não prova nada"
        );

        drop(jail); // KILL_ON_JOB_CLOSE acontece aqui.
        sleep(Duration::from_millis(700));
        let depois = conta("PING.EXE");
        assert_eq!(
            depois, antes,
            "fechar o job tem de matar o neto (antes={antes}, depois={depois})"
        );
    }

    /// `CREATE_SUSPENDED` sem resume seria um processo travado para sempre —
    /// garante que a varredura de threads do ToolHelp realmente destrava, e que
    /// o processo roda até o fim com o código de saída certo.
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

    /// PID inexistente tem de virar erro, não sucesso silencioso: um
    /// `capture_and_resume` que devolve Ok sem prender ninguém deixaria o
    /// chamador convencido de que há isolamento onde não há.
    #[test]
    fn pid_inexistente_falha_em_vez_de_fingir_sucesso() {
        let jail = Jail::new().expect("job");
        // PID improvável de existir; se existir, ainda assim não é nosso filho
        // suspenso e a captura falha por falta de direitos.
        assert!(jail.capture_and_resume(0xFFFF_FFF0).is_err());
    }
}
