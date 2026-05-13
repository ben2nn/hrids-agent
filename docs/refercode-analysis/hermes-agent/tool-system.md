# Hermes Agent 工具系统分析

---

## 一、工具注册表（Registry）

### 1.1 单例模式 + AST 自动发现

```python
class ToolRegistry:
    _instance = None

    def __new__(cls):
        if cls._instance is None:
            cls._instance = super().__new__(cls)
            cls._instance._init_registry()
        return cls._instance

    def _init_registry(self):
        """初始化时自动扫描 tools/ 目录"""
        self._scan_tools_directory()
```

**AST 自动发现机制**：
- 扫描 `tools/` 目录下所有 `.py` 文件
- 通过 AST 解析识别带有 `@tool` 装饰器的函数
- 自动提取函数名、参数类型、docstring 作为工具描述
- 无需手动注册，新增工具只需在 `tools/` 目录添加文件

### 1.2 工具定义

```python
@tool(
    name="read_file",
    description="读取指定路径的文件内容",
    category="file",           # 工具分类
    requires_confirmation=False, # 是否需要用户确认
    is_destructive=False,       # 是否为破坏性操作
)
async def read_file(path: str) -> str:
    """读取文件内容"""
    ...
```

### 1.3 工具分类

| 类别 | 工具示例 | 说明 |
|------|---------|------|
| `file` | read_file, write_file, edit_file | 文件操作 |
| `shell` | run_command, execute_script | Shell 命令 |
| `web` | fetch_url, web_search | 网络访问 |
| `code` | analyze_code, refactor | 代码分析 |
| `system` | get_env, set_env | 系统操作 |

---

## 二、可组合 Toolset

### 2.1 Toolset 定义

```python
class Toolset:
    """可组合的工具集合"""
    name: str
    tools: list[str]           # 工具名列表
    includes: list[str]        # 引用其他 Toolset
    description: str
```

### 2.2 组合机制

```yaml
# toolsets.yaml
file_operations:
  tools: [read_file, write_file, edit_file]
  description: "文件操作工具集"

code_review:
  includes: [file_operations]    # 组合 file_operations
  tools: [analyze_code, suggest_refactor]
  description: "代码审查工具集"

full_access:
  includes: [code_review]        # 递归组合
  tools: [run_command, web_search]
  description: "完整工具集"
```

**解析流程**：
```
full_access
    ├── code_review
    │   ├── file_operations
    │   │   ├── read_file
    │   │   ├── write_file
    │   │   └── edit_file
    │   ├── analyze_code
    │   └── suggest_refactor
    ├── run_command
    └── web_search
```

### 2.3 工具编排层（model_tools.py）

```python
class ModelTools:
    """工具编排层，管理工具生命周期"""

    async def execute_tool(self, name: str, args: dict) -> ToolResult:
        # 1. 查找工具
        tool = self.registry.get(name)

        # 2. 权限检查
        if tool.requires_confirmation:
            await self._request_confirmation(tool, args)

        # 3. 输入验证
        validated_args = self._validate_args(tool, args)

        # 4. 执行
        result = await tool.func(**validated_args)

        # 5. 结果后处理
        return self._post_process(result)
```

---

## 三、Skills 系统

### 3.1 渐进式披露（Progressive Disclosure）

```
Tier 1: 元数据（名称、描述、分类）
    ↓ 搜索和列表展示
Tier 2: 完整文本（指令、示例）
    ↓ 用户选择后加载
Tier 3: 关联文件（配置、模板）
    ↓ 执行时加载
```

**优化效果**：Tier 1 元数据常驻内存，Tier 2/3 按需加载，减少初始内存占用。

### 3.2 Skills 定义

```python
# skills/code_review.yaml
name: code_review
description: "代码审查技能"
category: development
tier1:
  summary: "对代码进行全面审查"
tier2:
  instructions: |
    1. 检查代码风格
    2. 识别潜在 bug
    3. 提出改进建议
  examples:
    - input: "审查 main.py"
      output: "发现 3 个潜在问题..."
tier3:
  files:
    - templates/review_report.md
    - configs/style_rules.json
```

### 3.3 Skills 安全扫描（skills_guard.py）

```python
class SkillsGuard:
    """技能安全扫描器"""

    # 100+ 威胁模式
    THREAT_PATTERNS = [
        r'exec\s*\(',                    # 代码执行
        r'eval\s*\(',                    # 动态求值
        r'__import__\s*\(',              # 动态导入
        r'subprocess\.(?:call|run|Popen)', # 子进程
        r'os\.(?:system|popen|exec)',     # OS 命令
        r'open\s*\(.+["\']w',            # 文件写入
        r'requests\.(?:get|post)',        # 网络请求
        r'socket\.',                      # Socket 操作
        # ... 100+ 模式
    ]

    # 信任级别
    TRUST_LEVELS = {
        'builtin': 0,      # 内置技能，完全信任
        'trusted': 1,      # 官方认证，基本信任
        'community': 2,    # 社区贡献，需要扫描
        'untrusted': 3,    # 未信任，严格限制
    }

    def scan(self, skill_path: str) -> ScanResult:
        """扫描技能文件"""
        issues = []
        for pattern in self.THREAT_PATTERNS:
            if re.search(pattern, content):
                issues.append(ThreatMatch(pattern, line, severity))
        return ScanResult(passed=len(issues) == 0, issues=issues)
```

### 3.4 Skills 远程安装（skills_hub.py）

```python
class SkillsHub:
    """技能远程安装"""

    async def install(self, skill_name: str, source: str = 'official'):
        # 1. 下载技能包
        package = await self._download(skill_name, source)

        # 2. 安全扫描
        scan_result = self.guard.scan(package.path)
        if not scan_result.passed:
            raise SecurityError(scan_result.issues)

        # 3. 解压到 skills 目录
        self._extract(package, self.skills_dir)

        # 4. 注册到 Registry
        self.registry.register_skill(package.metadata)
```

---

## 四、MCP 工具集成

### 4.1 MCP 工具映射

```python
# mcp_serve.py
MCP_TOOLS = {
    'create_session': create_session,
    'list_sessions': list_sessions,
    'get_session': get_session,
    'delete_session': delete_session,
    'send_message': send_message,
    'get_messages': get_messages,
    'search_messages': search_messages,
    'export_session': export_session,
    'import_session': import_session,
    'get_agent_status': get_agent_status,
}
```

### 4.2 跨平台会话管理

通过 MCP 协议暴露 10 个工具，支持：
- 会话 CRUD 操作
- 消息搜索（利用 FTS5）
- 会话导入/导出
- 代理状态查询

---

## 五、关键设计模式

| 模式 | 应用 | 价值 |
|------|------|------|
| 单例注册表 | ToolRegistry | 全局唯一工具注册中心 |
| AST 自动发现 | @tool 装饰器扫描 | 零配置工具注册 |
| 可组合 Toolset | includes 引用机制 | 灵活的工具集管理 |
| 渐进式披露 | Skills 3 Tier | 减少内存占用 |
| 安全扫描 | 100+ 威胁模式 | 技能沙箱安全 |
| 编排层 | ModelTools | 工具生命周期管理 |
