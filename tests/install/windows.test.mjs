import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const windows = process.platform === 'win32';
const quote = value => `'${value.replaceAll("'", "''")}'`;
function powershell(script) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'PSMODULEPATH') delete env[key];
  const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);\n" + script, 'utf16le').toString('base64')],
  { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0, result.error?.message || result.stderr || result.stdout);
  return JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
}

test('PowerShell installers parse with either Git checkout newline format', { skip: !windows }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-web-parser-'));
  try {
    for (const file of ['install.ps1', 'uninstall.ps1']) {
      const source = fs.readFileSync(path.join(root, file), 'utf8');
      for (const newline of ['\n', '\r\n']) {
        const target = path.join(temp, file);
        fs.writeFileSync(target, source.replace(/\r?\n/g, newline));
        const result = powershell(String.raw`$tokens=$null; $errors=$null
[void][Management.Automation.Language.Parser]::ParseFile(${quote(target)},[ref]$tokens,[ref]$errors)
@{errors=@($errors | ForEach-Object { $_.ErrorId })} | ConvertTo-Json -Compress`);
        assert.deepEqual(result.errors, [], `${file}, ${JSON.stringify(newline)}`);
      }
    }
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('Windows installation owns only local service configuration and survives relocation', { skip: !windows }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-web-install-'));
  const checkout = path.join(temp, "迁移🙂 [source]'s folder");
  const home = path.join(temp, "用户🙂 [home]'s folder");
  const binaryDir = path.join(home, 'custom install');
  fs.mkdirSync(checkout, { recursive: true });
  const installer = path.join(checkout, 'install.ps1');
  const source = path.join(checkout, 'source.exe');
  fs.copyFileSync(path.join(root, 'install.ps1'), installer);
  fs.copyFileSync(path.join(root, 'uninstall.ps1'), path.join(checkout, 'uninstall.ps1'));
  fs.writeFileSync(source, 'isolated source build');
  try {
    const result = powershell(String.raw`
Set-Variable HOME ${quote(home)} -Force
$env:PI_WEB_SOURCE_BINARY=${quote(source)}
$env:PI_WEB_SOURCE_VERSION='fixture'
$env:PI_WEB_INSTALL_DIR=${quote(binaryDir)}
$env:PI_CODING_AGENT_DIR=Join-Path $HOME 'native data'
Remove-Item Env:PI_WEB_INPLACE_UPDATE,Env:PI_WEB_TOKEN -ErrorAction SilentlyContinue
$config=Join-Path $HOME '.config/pi-web'
[void](New-Item -ItemType Directory -Force $config)
$envFile=Join-Path $config 'env'
$settings=@('PI_WEB_TOKEN=fixture-token','HTTPS_PROXY=http://127.0.0.1:10808','CUSTOM_SETTING=中文 空格')
[IO.File]::WriteAllLines($envFile,($settings+@('Path=stale build path','PSModulePath=stale host path')),[Text.UTF8Encoding]::new($false))
$calls=[pscustomobject]@{starts=0;registryWrites=0;queries=0;captured=$null}
function Write-Host {}
function Get-Process { $calls.queries++; @() }
function Start-Sleep {}
function Set-ItemProperty { param($Path,$Name,$Value) $calls.registryWrites++ }
function Start-Process { param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError) $calls.starts++ }
& ${quote(installer)}
$contents=[IO.File]::ReadAllLines($envFile,[Text.Encoding]::UTF8)
if(@($contents | Where-Object { $_ -match '^\s*(PATH|PSModulePath)\s*=' }).Count){throw 'Persisted build or shell environment snapshot'}
foreach($line in $settings){if($contents -cnotcontains $line){throw 'Service setting was lost or re-encoded'}}
$launcher=Join-Path $config 'pi-web-start.ps1'
[IO.File]::WriteAllText($launcher,'obsolete launcher')
& ${quote(installer)}
if($calls.starts -ne 1 -or $calls.registryWrites -ne 2){throw 'Same-build installation did not repair configuration without restarting'}
$launcherText=[IO.File]::ReadAllText($launcher,[Text.Encoding]::UTF8)
if($launcherText -match [regex]::Escape(${quote(checkout)})){throw 'Launcher depends on source checkout'}
$vbs=Join-Path $config 'pi-web-start.vbs'
$vbsText=[IO.File]::ReadAllText($vbs)
if($vbsText -notmatch 'PSModulePath'){throw 'VBS inherits another PowerShell host module path'}
$env:Path='stale parent path'
$expectedModules=$env:PSModulePath
$calls.captured=$null
function Start-Process {
 param($FilePath,$ArgumentList,$WorkingDirectory,$WindowStyle,$RedirectStandardOutput,$RedirectStandardError)
 $calls.starts++
 $calls.captured=@{binary=$FilePath;cwd=$WorkingDirectory;path=$env:Path;modules=$env:PSModulePath;token=$env:PI_WEB_TOKEN;custom=$env:CUSTOM_SETTING}
}
& $launcher
$expectedPath=[Environment]::ExpandEnvironmentVariables([Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User'))
if($calls.captured.binary -ne (Join-Path ${quote(binaryDir)} 'pi-web.exe') -or $calls.captured.cwd -ne $HOME){throw 'Local installed paths were not quoted correctly'}
if($calls.captured.path -cne $expectedPath){throw 'Launcher did not use current registered Windows PATH'}
if($calls.captured.modules -cne $expectedModules){throw 'Launcher replaced the current PowerShell host module path'}
if($calls.captured.token -ne 'fixture-token' -or $calls.captured.custom -cne '中文 空格'){throw 'Launcher did not preserve UTF-8 service settings'}
# In-place updates must not change configuration or start/stop processes.
$before=@{}
$startsBefore=$calls.starts; $writesBefore=$calls.registryWrites
foreach($file in @($envFile,$launcher,$vbs)){$before[$file]=(Get-FileHash -LiteralPath $file).Hash}
[IO.File]::WriteAllText(${quote(source)},'new isolated build')
$env:PI_WEB_INPLACE_UPDATE='1'
& ${quote(installer)}
foreach($file in $before.Keys){if((Get-FileHash -LiteralPath $file).Hash -ne $before[$file]){throw 'In-place update rewrote configuration'}}
if($calls.starts -ne $startsBefore -or $calls.registryWrites -ne $writesBefore -or $calls.queries -ne 0){throw 'In-place update changed running processes or startup registration'}
if([IO.File]::ReadAllText((Join-Path ${quote(binaryDir)} 'pi-web.exe')) -ne 'new isolated build'){throw 'In-place update skipped source binary'}
# Uninstall the same custom path without touching user data or real Run keys.
function Remove-ItemProperty {}
$data=Join-Path $HOME '.pi/agent'
[void](New-Item -ItemType Directory -Force (Join-Path $data 'sessions'))
[IO.File]::WriteAllText((Join-Path $data 'sessions/history.jsonl'),'preserved history')
[IO.File]::WriteAllText((Join-Path $data 'pi-web.sqlite'),'preserved settings')
& ${quote(path.join(checkout, 'uninstall.ps1'))}
if(Test-Path -LiteralPath (Join-Path ${quote(binaryDir)} 'pi-web.exe')){throw 'Uninstaller left custom binary'}
foreach($file in @($launcher,$vbs)){if(Test-Path -LiteralPath $file){throw 'Uninstaller left custom launcher'}}
if(-not (Test-Path -LiteralPath $envFile) -or [IO.File]::ReadAllText((Join-Path $data 'sessions/history.jsonl')) -ne 'preserved history' -or [IO.File]::ReadAllText((Join-Path $data 'pi-web.sqlite')) -ne 'preserved settings'){throw 'Uninstaller modified user data'}
@{relocated=$true;settingsPreserved=$true;sameBuildRepair=$true;freshEnvironment=$true;inplacePreserved=$true;uninstallPreserved=$true} | ConvertTo-Json -Compress
`);
    assert.ok(Object.values(result).every(Boolean));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});

test('lifecycle keeps Git Bash build environment out of installation and resets PowerShell host state', { skip: !windows }, () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-web-lifecycle-'));
  try {
    const checkout = path.join(temp, "新 location's source");
    const shims = path.join(temp, 'tools');
    fs.mkdirSync(path.join(checkout, 'scripts'), { recursive: true });
    fs.mkdirSync(shims);
    fs.copyFileSync(path.join(root, 'scripts/run-lifecycle.mjs'), path.join(checkout, 'scripts/run-lifecycle.mjs'));
    const fixture = path.join(temp, 'main.go');
    fs.writeFileSync(fixture, `package main
import("os";"path/filepath";"strings";"encoding/json";"fmt")
func main(){
 if len(os.Args)>1 && os.Args[1]=="-version" { fmt.Println("fixture");return }
 if strings.EqualFold(filepath.Base(os.Args[0]),"powershell.exe") {
  b,_:=json.Marshal(map[string]any{"path":os.Getenv("PATH"),"modules":os.Getenv("PSModulePath"),"cwd":mustCwd(),"args":os.Args[1:]})
  if err:=os.WriteFile(os.Getenv("PI_WEB_FIXTURE_REPORT"),b,0600);err!=nil{panic(err)};return
 }
 for _,arg:=range os.Args[1:] { if strings.HasPrefix(arg,"BINARY=") { exe,_:=os.Executable();b,_:=os.ReadFile(exe);if err:=os.WriteFile(strings.TrimPrefix(arg,"BINARY="),b,0700);err!=nil{panic(err)} } }
}
func mustCwd()string{v,_:=os.Getwd();return v}
`);
    const make = path.join(shims, 'make.exe');
    const build = spawnSync('go', ['build', '-o', make, fixture], { encoding: 'utf8', timeout: 60000 });
    assert.equal(build.status, 0, build.stderr);
    fs.copyFileSync(make, path.join(shims, 'powershell.exe'));
    const report = path.join(temp, 'report.json');
    const env = { ...process.env };
    for (const key of Object.keys(env)) if (['PATH', 'PSMODULEPATH'].includes(key.toUpperCase())) delete env[key];
    const originalPath = shims + path.delimiter + process.env.PATH;
    Object.assign(env, { PATH: originalPath, PSModulePath: 'foreign PowerShell host', MAKE: make, PI_WEB_FIXTURE_REPORT: report });
    const result = spawnSync(process.execPath, [path.join(checkout, 'scripts/run-lifecycle.mjs'), 'install'],
      { cwd: temp, env, encoding: 'utf8', timeout: 30000 });
    assert.equal(result.status, 0, result.stderr);
    const actual = JSON.parse(fs.readFileSync(report, 'utf8'));
    assert.equal(actual.path, originalPath);
    assert.equal(actual.modules, '');
    assert.equal(actual.cwd.toLowerCase(), checkout.toLowerCase());
    assert.equal(actual.args.at(-1), path.join(checkout, 'install.ps1'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
