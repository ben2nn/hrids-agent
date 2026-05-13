# Hermes Agent 参考价值评估

---

## 一、高参考价值（可直接借鉴）

### 1.1 ProviderProfile 声明式配置

**价值**：极高

**适用场景**：多 LLM 提供商适配

**核心思想**：
- 通过数据类而非继承定义提供商差异
- 请求/响应转换函数作为配置项
- 新提供商只需创建 Profile 实例

**借鉴要点**：
```python
@dataclass
class ProviderProfile:
    name: str
    base_url: str
    api_key_env: str
    models: list[str]
    default_model: str
    supports_tools: bool
    transform_request: Callable   # 请求转换
    transform_response: Callable  # 响应转换

# 新增提供商只需
deepseek = ProviderProfile(
    name="deepseek",
    base_url="https://api.deepseek.com/v1",
    api_key_env="DEEPSEEK_API_KEY",
    models=["deepseek-chat", "deepseek-coder"],
    default_model="deepseek-chat",
    supports_tools=True,
    transform_request=identity,  # 兼容 OpenAI 格式
    transform_response=identity,
)
```

### 1.2 AST 自动发现工具注册

**价值**：极高

**适用场景**：工具系统零配置注册

**核心思想**：
- 通过 AST 解析扫描 `@tool` 装饰器
- 自动提取工具元数据（名称、描述、参数）
- 新增工具只需在目录添加文件

**借鉴要点**：
```python
# 装饰器定义
@tool(
    name="read_file",
    description="读取文件内容",
    category="file",
)
async def read_file(path: str) -> str:
    ...

# 注册表自动扫描
class ToolRegistry:
    def _scan_directory(self, path: str):
        for file in Path(path).glob("*.py"):
            tree = ast.parse(file.read_text())
            for node in ast.walk(tree):
                if self._has_tool_decorator(node):
                    self._register_tool(node)
```

### 1.3 可组合 Toolset

**价值**：高

**适用场景**：灵活的工具集管理

**核心思想**：
- Toolset 支持 `includes` 引用其他 Toolset
- 递归组合，构建复杂工具集
- YAML 配置，易于维护

**借鉴要点**：
```yaml
# toolsets.yaml
file_ops:
  tools: [read_file, write_file, edit_file]

code_review:
  includes: [file_ops]      # 组合 file_ops
  tools: [analyze_code]

full_access:
  includes: [code_review]   # 递归组合
  tools: [run_command]
```

### 1.4 渐进式 Skills 披露

**价值**：高

**适用场景**：技能/命令系统优化

**核心思想**：
- Tier 1: 元数据（常驻内存）
- Tier 2: 完整文本（按需加载）
- Tier 3: 关联文件（执行时加载）

**借鉴要点**：
```python
class Skill:
    tier1: SkillMetadata    # 名称、描述、分类
    tier2: SkillContent     # 指令、示例（用户选择后加载）
    tier3: SkillFiles       # 配置、模板（执行时加载）

    def get_metadata(self) -> SkillMetadata:
        return self.tier1  # 始终可用

    async def get_content(self) -> SkillContent:
        if not self._tier2_loaded:
            self.tier2 = await self._load_tier2()
        return self.tier2
```

### 1.5 Skills 安全扫描

**价值**：高

**适用场景**：插件/技能安全审计

**核心思想**：
- 100+ 正则威胁模式
- 信任级别分级（builtin/trusted/community/untrusted）
- 安装前自动扫描

**借鉴要点**：
```python
class SkillsGuard:
    THREAT_PATTERNS = [
        r'exec\s*\(',
        r'eval\s*\(',
        r'__import__\s*\(',
        r'subprocess\.(?:call|run|Popen)',
        # ... 100+ 模式
    ]

    TRUST_LEVELS = {
        'builtin': 0,
        'trusted': 1,
        'community': 2,
        'untrusted': 3,
    }

    def scan(self, code: str) -> ScanResult:
        issues = []
        for pattern in self.THREAT_PATTERNS:
            if re.search(pattern, code):
                issues.append(ThreatMatch(pattern))
        return ScanResult(passed=len(issues) == 0, issues=issues)
```

---

## 二、中等参考价值（理念可借鉴）

### 2.1 SQLite + FTS5 状态管理

**价值**：中高

**说明**：使用 SQLite 存储状态，FTS5 实现全文搜索，trigram tokenizer 支持 CJK 模糊搜索。

### 2.2 系统提示词 3 层缓存

**价值**：中高

**说明**：静态层（角色定义）、动态层（工具列表）、上下文层（会话摘要）分别缓存，减少重复构建。

### 2.3 ACP 适配器

**价值**：中

**说明**：Agent Communication Protocol 允许代码编辑器直接调用代理，适用于 IDE 集成场景。

### 2.4 MCP 服务器暴露

**价值**：中

**说明**：通过 MCP 协议暴露 10 个工具，支持跨平台会话管理。

### 2.5 动态 Platform 枚举

**价值**：中

**说明**：枚举支持 `_missing_` 方法，运行时注册新平台成员。

---

## 三、低参考价值（差异较大）

| 模块 | 说明 |
|------|------|
| 多平台网关（20+） | 特定于消息平台集成，hrids-agent 可能不需要 |
| WeChat/DingTalk 适配器 | 特定于国内平台，依赖私有 API |
| 轨迹压缩 | 简单的滑动窗口摘要，不如 Claude Code 四层压缩精细 |

---

## 四、与其他参考项目的对比

| 维度 | Hermes Agent | Claude Code | DeepSeek-TUI | DeepSeek-Reasonix |
|------|-------------|-------------|-------------|-------------------|
| 语言 | Python | TypeScript | Rust | TypeScript |
| 架构模式 | 插件驱动 | AsyncGenerator 管道 | Actor + 事件驱动 | Cache-First Loop |
| 提供商支持 | 28+ 声明式 | 单一 (Anthropic) | 9 配置式 | 单一 (DeepSeek) |
| 平台支持 | 20+ 网关 | 终端/IDE/远程 | 终端 | 终端 |
| 工具发现 | AST 自动扫描 | 静态注册 | 延迟加载 + BM25 | 静态注册 |
| 工具组合 | 可组合 Toolset | 工具池 | 工具池 | 工具池 |
| 技能系统 | 渐进式 3 Tier | 命令系统 | 无 | 无 |
| 安全扫描 | 100+ 模式 | 分层权限 | 三层安全屏障 | 白名单 |
| 状态管理 | SQLite + FTS5 | JSONL | SQLite | JSONL |
| 代码编辑器 | ACP + MCP | IDE 扩展 | 无 | 无 |

---

## 五、借鉴优先级建议

### P0（立即引入）

1. **ProviderProfile 声明式配置** — 多提供商适配的优雅方案
2. **AST 自动发现工具注册** — 零配置工具系统
3. **可组合 Toolset** — 灵活的工具集管理

### P1（近期引入）

4. **渐进式 Skills 披露** — 技能系统优化
5. **Skills 安全扫描** — 插件安全审计
6. **SQLite + FTS5 状态管理** — 全文搜索能力

### P2（中期引入）

7. **系统提示词 3 层缓存** — 性能优化
8. **ACP 适配器** — 代码编辑器集成
9. **MCP 服务器暴露** — 跨平台会话管理
10. **动态 Platform 枚举** — 可扩展性设计
