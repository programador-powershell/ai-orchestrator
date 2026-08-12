use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    Chat,
    Work,
    Design,
    Data,
    Agent,
    Code,
    Security,
    Office,
    Tune,
}
impl Mode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Work => "work",
            Self::Design => "design",
            Self::Data => "data",
            Self::Agent => "agent",
            Self::Code => "code",
            Self::Security => "security",
            Self::Office => "office",
            Self::Tune => "tune",
        }
    }

    /// Todos os modos que o servidor conhece — a política itera por aqui.
    pub const ALL: [Mode; 9] = [
        Mode::Chat,
        Mode::Work,
        Mode::Design,
        Mode::Data,
        Mode::Agent,
        Mode::Code,
        Mode::Security,
        Mode::Office,
        Mode::Tune,
    ];

    pub fn parse(value: &str) -> Option<Mode> {
        Mode::ALL.into_iter().find(|mode| mode.as_str() == value)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Capability {
    Chat,
    Image,
    Embedding,
    Rerank,
}
impl Capability {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Chat => "chat",
            Self::Image => "image",
            Self::Embedding => "embedding",
            Self::Rerank => "rerank",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTarget {
    pub provider_id: Uuid,
    pub model: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteConfig {
    pub mode: Mode,
    pub capability: Capability,
    pub primary: ModelTarget,
    #[serde(default)]
    pub fallbacks: Vec<ModelTarget>,
    pub temperature: Option<f32>,
    pub max_tokens: Option<u32>,
    #[serde(default)]
    pub allowed_capabilities: Vec<Capability>,
    pub timeout_ms: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Value,
}

#[derive(Clone, Debug, Deserialize)]
pub struct ChatRequest {
    pub mode: Mode,
    pub messages: Vec<ChatMessage>,
    #[serde(default)]
    pub stream: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignReplicationRequest {
    pub source_url: String,
    #[serde(default = "default_design_capture_mode")]
    pub mode: String,
    #[serde(default = "default_design_max_pages")]
    pub max_pages: u8,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum OrchestrationNodeKind {
    Input,
    Agent,
    Tool,
    Gate,
    Merge,
    Human,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationNode {
    pub id: String,
    pub name: String,
    pub kind: OrchestrationNodeKind,
    pub mode: Option<Mode>,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default)]
    pub config: Value,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationGraph {
    pub schema_version: u8,
    pub name: String,
    #[serde(default = "default_max_concurrency")]
    pub max_concurrency: usize,
    pub nodes: Vec<OrchestrationNode>,
}

fn default_max_concurrency() -> usize {
    4
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrchestrationPlan {
    pub valid: bool,
    pub graph_name: String,
    pub waves: Vec<Vec<String>>,
    pub critical_path: Vec<String>,
    pub max_parallelism: usize,
    pub warnings: Vec<String>,
}

fn default_design_capture_mode() -> String {
    "static".into()
}

fn default_design_max_pages() -> u8 {
    1
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct OidcClaims {
    pub sub: String,
    pub email: Option<String>,
    pub name: Option<String>,
    pub exp: usize,
    pub iss: String,
    pub aud: Value,
    /// Claim `groups` do Entra (ObjectIds). Acima de ~150 grupos vira
    /// overage e chega vazio — por isso o caminho recomendado são app roles.
    #[serde(default)]
    pub groups: Vec<String>,
    /// App roles do registro do aplicativo — o canal recomendado pela
    /// Microsoft para autorização (sem limite de overage).
    #[serde(default)]
    pub roles: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Identity {
    pub subject: String,
    pub email: Option<String>,
    pub name: Option<String>,
    /// groups ∪ roles do token — a política casa contra ad_groups por
    /// ObjectId OU nome, então os dois canais funcionam.
    pub groups: Vec<String>,
}
