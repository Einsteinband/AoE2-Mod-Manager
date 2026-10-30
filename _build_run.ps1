$env:CARGO_HOME='F:\Rust\.cargo'
$env:RUSTUP_HOME='F:\Rust\.rustup'
$env:PATH='F:\Rust\.cargo\bin;F:\mingw\mingw64\bin;' + $env:PATH
Set-Location 'F:\AoE2ModManager'
npm run tauri build *>&1 | Out-File -FilePath 'F:\AoE2ModManager\build.log' -Encoding utf8
"EXITCODE=$LASTEXITCODE" | Out-File -FilePath 'F:\AoE2ModManager\build.log' -Encoding utf8 -Append