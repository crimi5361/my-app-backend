<#
.SYNOPSIS
  Recrée la base LOCALE de test de l'intégration avec l'Application B : schéma de production
  (fichier pg_dump --schema-only), migration 001, données fictives.

.EXAMPLE
  .\tests\integration_b\preparer_base.ps1 -Schema "D:\DEV\App A\schema_production_20261108.sql"

.NOTES
  Variables : PGHOST (localhost), PGUSER (postgres), PGPASSWORD, PSQL (chemin de psql.exe).
  Ne jamais viser la base de production : la base est supprimée puis recréée.
#>
param(
    [Parameter(Mandatory = $true)][string]$Schema,
    [string]$Base = "myiipea_local"
)
$ErrorActionPreference = "Stop"
$psql = if ($env:PSQL) { $env:PSQL } else { "psql" }
$hote = if ($env:PGHOST) { $env:PGHOST } else { "localhost" }
$utilisateur = if ($env:PGUSER) { $env:PGUSER } else { "postgres" }
if ($hote -notin @("localhost", "127.0.0.1")) { throw "Base locale uniquement (PGHOST=$hote refusé)." }
$ici = Split-Path -Parent $MyInvocation.MyCommand.Path
$migrations = Join-Path $ici "..\..\migrations\integration_b"
# Les avis (NOTICE) de psql passent sur stderr : PowerShell 5.1 les prendrait pour des erreurs.
$env:PGOPTIONS = "-c client_min_messages=warning"

& $psql -h $hote -U $utilisateur -q -c "DROP DATABASE IF EXISTS $Base;" -c "CREATE DATABASE $Base;"
foreach ($fichier in @($Schema, (Join-Path $migrations "001_integration_application_b.sql"), (Join-Path $ici "donnees_fictives.sql"))) {
    & $psql -h $hote -U $utilisateur -d $Base -q -v ON_ERROR_STOP=1 -f $fichier
    if ($LASTEXITCODE -ne 0) { throw "Échec : $fichier" }
}
Write-Output "Base $Base prête."
