param(
    [Parameter(Mandatory)][string]$PiPackageDir,
    [string]$TypeScriptPath
)
$ErrorActionPreference = 'Stop'
$PiPackageDir = (Resolve-Path -LiteralPath $PiPackageDir).Path
$nodeModules = Split-Path (Split-Path $PiPackageDir -Parent) -Parent
if (-not (Test-Path -LiteralPath (Join-Path $nodeModules 'jiti'))) {
    $nodeModules = Join-Path $PiPackageDir 'node_modules'
}
$repository = Split-Path $PSScriptRoot -Parent
if (-not (Test-Path -LiteralPath (Join-Path $PiPackageDir 'dist/index.js'))) {
    throw 'PiPackageDir must point to an installed @earendil-works/pi-coding-agent package'
}

# Use existing system tools and the explicitly selected Pi installation; never install dependencies.
$validationConfig = Join-Path $repository ('.tsconfig-test-' + [guid]::NewGuid().ToString('N') + '.json')
$aliases = @{
    '@earendil-works/pi-coding-agent' = @((Join-Path $PiPackageDir 'dist/index.d.ts'))
    '@earendil-works/pi-ai' = @((Join-Path $nodeModules '@earendil-works/pi-ai/dist/index.d.ts'))
    '@earendil-works/pi-tui' = @((Join-Path $nodeModules '@earendil-works/pi-tui/dist/index.d.ts'))
    'typebox' = @((Join-Path $nodeModules 'typebox/build/index.d.mts'))
}
$config = @{
    compilerOptions = @{
        strict = $true; noEmit = $true; skipLibCheck = $true
        target = 'ES2022'; module = 'ESNext'; moduleResolution = 'Bundler'
        types = @('node'); typeRoots = @((Join-Path $nodeModules '@types'))
        paths = $aliases
    }
    include = @('extensions/**/*.ts', 'tests/**/*.ts')
}
$runner = '(async()=>{const {pathToFileURL}=require("node:url");const {createRequire}=require("node:module");const nm=process.argv[1],pkg=process.argv[2];const req=createRequire(pathToFileURL(pkg+"/dist/index.js").href);const {createJiti}=require(nm+"/jiti");const j=createJiti(pathToFileURL(pkg+"/dist/core/extensions/loader.js").href,{alias:{"@earendil-works/pi-ai":nm+"/@earendil-works/pi-ai/dist/index.js","@earendil-works/pi-coding-agent":pkg+"/dist/index.js","@earendil-works/pi-tui":req.resolve("@earendil-works/pi-tui"),typebox:req.resolve("typebox"),"typebox/compile":req.resolve("typebox/compile"),"typebox/value":req.resolve("typebox/value")}});await j.import(process.argv[3])})().catch(e=>{console.error(e);process.exitCode=1})'

try {
    $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $validationConfig -Encoding utf8
    if ($TypeScriptPath) { node $TypeScriptPath -p $validationConfig }
    else { tsc -p $validationConfig }
    if ($LASTEXITCODE -ne 0) { throw 'TypeScript check failed' }
    foreach ($test in @(
        'extensions/web-search/config.test.ts', 'extensions/web-search/providers.test.ts',
        'extensions/web-search/adapters.test.ts', 'extensions/web-search/registration.test.ts',
        'extensions/web-search/settings.test.ts', 'tests/package.test.ts',
        'extensions/permission-gate/policy.test.ts', 'extensions/permission-gate/elevation.test.ts',
        'extensions/permission-gate/authorization.test.ts', 'extensions/permission-gate/lifecycle.test.ts',
        'extensions/permission-gate/approval.test.ts', 'extensions/permission-gate/dialog.test.ts',
        'extensions/plugin-manager/config.test.ts', 'extensions/plugin-manager/runtime.test.ts',
        'extensions/ai-rename/ai-rename.test.ts', 'extensions/auto-summary/document.test.ts',
        'extensions/auto-summary/naming.test.ts', 'extensions/tps-status/tps.test.ts',
        'extensions/write-transforms/matcher.test.ts', 'extensions/write-transforms/write-transforms.test.ts',
        'extensions/notify-dot/notify-dot.test.ts', 'extensions/notify-dot/focus-diagnostics.test.ts',
        'extensions/notify-dot/fullscreen-focus.test.ts',
        'extensions/powershell-bash/powershell-bash.test.ts', 'extensions/powershell-bash/diagnostics.test.ts',
        'extensions/run-script/process.test.ts'
    )) {
        Write-Output "Running $test"
        node -e $runner $nodeModules $PiPackageDir (Join-Path $repository $test)
        if ($LASTEXITCODE -ne 0) { throw "Test failed: $test" }
    }
} finally {
    if (Test-Path -LiteralPath $validationConfig) { Remove-Item -LiteralPath $validationConfig }
}
