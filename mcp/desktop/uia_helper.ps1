# uia_helper.ps1 — Windows UI Automation helper for the DSH desktop MCP server.
# Zero-dependency: uses the built-in .NET Framework UIAutomationClient (Windows PowerShell 5.1).
# Input:  one JSON argument describing the action.
# Output: one JSON line to stdout.
param([Parameter(Mandatory=$true)][string]$Json)

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$AE = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]

$req = $Json | ConvertFrom-Json

function Get-Window([string]$titleLike) {
    $root = $AE::RootElement
    $windows = $root.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition)
    foreach ($w in $windows) {
        $n = $w.Current.Name
        if ($n -and ($n -like "*$titleLike*")) { return $w }
    }
    return $null
}

function Get-Condition([string]$name, [string]$ctrlType) {
    $c1 = New-Object System.Windows.Automation.PropertyCondition($AE::NameProperty, $name)
    if ($ctrlType) {
        $ct = $null
        switch ($ctrlType) {
            'Button'      { $ct = [System.Windows.Automation.ControlType]::Button }
            'Edit'        { $ct = [System.Windows.Automation.ControlType]::Edit }
            'Text'        { $ct = [System.Windows.Automation.ControlType]::Text }
            'MenuItem'    { $ct = [System.Windows.Automation.ControlType]::MenuItem }
            'List'        { $ct = [System.Windows.Automation.ControlType]::List }
            'ListItem'    { $ct = [System.Windows.Automation.ControlType]::ListItem }
            'CheckBox'    { $ct = [System.Windows.Automation.ControlType]::CheckBox }
            'Tab'         { $ct = [System.Windows.Automation.ControlType]::Tab }
            'TabItem'     { $ct = [System.Windows.Automation.ControlType]::TabItem }
            'Window'      { $ct = [System.Windows.Automation.ControlType]::Window }
            default       { $ct = $null }
        }
        if ($ct) {
            $c2 = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $ct)
            return New-Object System.Windows.Automation.AndCondition($c1, $c2)
        }
    }
    return $c1
}

function Find-Element($win, [string]$name, [string]$ctrlType) {
    if ($null -eq $win) { return $null }
    $cond = Get-Condition $name $ctrlType
    try { return $win.FindFirst($TS::Descendants, $cond) } catch { return $null }
}

function Try-Pattern($el, $patternType) {
    $pat = $null
    if ($el.TryGetCurrentPattern($patternType, [ref]$pat)) { return $pat }
    return $null
}

function Element-Info($el) {
    if ($null -eq $el) { return $null }
    $r = $el.Current.BoundingRectangle
    $info = [pscustomobject]@{
        name    = $el.Current.Name
        type    = ($el.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
        enabled = [bool]$el.Current.IsEnabled
        rect    = ("{0},{1},{2},{3}" -f $r.X, $r.Y, $r.Width, $r.Height)
        value   = $null
    }
    $vp = Try-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
    if ($null -ne $vp) { $info.value = $vp.Current.Value }
    return $info
}

$action = $req.action
$result = $null

try {
    switch ($action) {
        'tree' {
            $win = Get-Window $req.title
            if ($null -eq $win) { $result = [pscustomobject]@{ok=$false; msg="window not found: $($req.title)"}; break }
            $sw = [System.Diagnostics.Stopwatch]::StartNew()
            $out = New-Object System.Collections.Generic.List[object]
            $maxItems = [int]$req.max; if ($maxItems -le 0) { $maxItems = 150 }
            $depth = [int]$req.depth; if ($depth -le 0) { $depth = 3 }

            function Walk($el, $d) {
                if ($sw.ElapsedMilliseconds -gt 4000) { return }
                if ($d -le 0 -or $out.Count -ge $maxItems) { return }
                $children = $null
                try { $children = $el.FindAll($TS::Children, [System.Windows.Automation.Condition]::TrueCondition) } catch { return }
                foreach ($c in $children) {
                    if ($sw.ElapsedMilliseconds -gt 4000 -or $out.Count -ge $maxItems) { return }
                    $r = $c.Current.BoundingRectangle
                    if ($r.Width -le 0 -or $r.Height -le 0) { continue }
                    $name = $c.Current.Name
                    if (-not $name) { $name = $c.Current.AutomationId }
                    if (-not $name) { $name = '' }
                    $out.Add([pscustomobject]@{
                        name = $name
                        type = ($c.Current.ControlType.ProgrammaticName -replace '^ControlType\.', '')
                        en   = [bool]$c.Current.IsEnabled
                        rect = ("{0},{1},{2},{3}" -f $r.X, $r.Y, $r.Width, $r.Height)
                    })
                    Walk $c ($d - 1)
                }
            }
            Walk $win $depth
            $result = [pscustomobject]@{ok=$true; window=$win.Current.Name; items=$out.ToArray()}
        }
        'find' {
            $win = Get-Window $req.title
            $el = Find-Element $win $req.name $req.control_type
            if ($null -eq $el) { $result = [pscustomobject]@{ok=$false; msg="element not found: $($req.name)"}; break }
            $result = [pscustomobject]@{ok=$true; element=(Element-Info $el)}
        }
        'click' {
            $win = Get-Window $req.title
            $el = Find-Element $win $req.name $req.control_type
            if ($null -eq $el) { $result = [pscustomobject]@{ok=$false; msg="element not found: $($req.name)"}; break }
            $done = $false; $msg = ''
            $p = Try-Pattern $el ([System.Windows.Automation.InvokePattern]::Pattern)
            if ($null -ne $p) { $p.Invoke(); $done = $true; $msg = 'Invoke' }
            if (-not $done) {
                $p = Try-Pattern $el ([System.Windows.Automation.SelectionItemPattern]::Pattern)
                if ($null -ne $p) { $p.Select(); $done = $true; $msg = 'SelectionItem.Select' }
            }
            if (-not $done) {
                $p = Try-Pattern $el ([System.Windows.Automation.TogglePattern]::Pattern)
                if ($null -ne $p) { $p.Toggle(); $done = $true; $msg = 'Toggle' }
            }
            if (-not $done) {
                $p = Try-Pattern $el ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)
                if ($null -ne $p) { $p.Expand(); $done = $true; $msg = 'ExpandCollapse.Expand' }
            }
            if ($done) { $result = [pscustomobject]@{ok=$true; via=$msg} }
            else { $result = [pscustomobject]@{ok=$false; msg='no supported pattern (Invoke/Selection/Toggle/ExpandCollapse); fall back to desktop_click with rect coordinates'} }
        }
        'setvalue' {
            $win = Get-Window $req.title
            $el = Find-Element $win $req.name $req.control_type
            if ($null -eq $el) { $result = [pscustomobject]@{ok=$false; msg="element not found: $($req.name)"}; break }
            $p = Try-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
            if ($null -ne $p) {
                $p.SetValue([string]$req.value)
                $result = [pscustomobject]@{ok=$true; via='ValuePattern.SetValue'}
            } else {
                $result = [pscustomobject]@{ok=$false; msg='no ValuePattern; fall back to click + desktop_type'}
            }
        }
        'getvalue' {
            $win = Get-Window $req.title
            $el = Find-Element $win $req.name $req.control_type
            if ($null -eq $el) { $result = [pscustomobject]@{ok=$false; msg="element not found: $($req.name)"}; break }
            $p = Try-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
            $result = [pscustomobject]@{ok=$true; value=$p.Current.Value}
        }
        'text' {
            $win = Get-Window $req.title
            $el = Find-Element $win $req.name $req.control_type
            if ($null -eq $el) { $result = [pscustomobject]@{ok=$false; msg="element not found: $($req.name)"}; break }
            $tp = Try-Pattern $el ([System.Windows.Automation.TextPattern]::Pattern)
            if ($null -ne $tp) {
                $maxChars = [int]$req.max_chars; if ($maxChars -le 0) { $maxChars = 1500 }
                $result = [pscustomobject]@{ok=$true; text=$tp.DocumentRange.GetText($maxChars)}
            } else {
                $vp = Try-Pattern $el ([System.Windows.Automation.ValuePattern]::Pattern)
                if ($null -ne $vp) {
                    $result = [pscustomobject]@{ok=$true; text=$vp.Current.Value}
                } else {
                    $result = [pscustomobject]@{ok=$false; msg='no TextPattern/ValuePattern; use screenshots for content'}
                }
            }
        }
        'scroll' {
            $win = Get-Window $req.title
            $el = Find-Element $win $req.name $req.control_type
            if ($null -eq $el) { $result = [pscustomobject]@{ok=$false; msg="element not found: $($req.name)"}; break }
            $sp = Try-Pattern $el ([System.Windows.Automation.ScrollPattern]::Pattern)
            if ($null -eq $sp) { $result = [pscustomobject]@{ok=$false; msg='no ScrollPattern; fall back to desktop_scroll'}; break }
            $step = 12.0
            if ([string]$req.amount -eq 'large') { $step = 40.0 }
            $vp = [double]$sp.Current.VerticalScrollPercent
            $hp = [double]$sp.Current.HorizontalScrollPercent
            switch ([string]$req.direction) {
                'down'  { $vp = [Math]::Min(100.0, $vp + $step) }
                'up'    { $vp = [Math]::Max(0.0, $vp - $step) }
                'right' { $hp = [Math]::Min(100.0, $hp + $step) }
                'left'  { $hp = [Math]::Max(0.0, $hp - $step) }
            }
            $sp.SetScrollPercent([double]$hp, [double]$vp)
            $result = [pscustomobject]@{ok=$true; via='ScrollPattern.SetScrollPercent'; vp=$vp; hp=$hp}
        }
        default {
            $result = [pscustomobject]@{ok=$false; msg="unknown action: $action"}
        }
    }
} catch {
    $result = [pscustomobject]@{ok=$false; msg=$_.Exception.Message; line=$_.InvocationInfo.ScriptLineNumber}
}

if ($null -eq $result) { $result = [pscustomobject]@{ok=$false; msg='no result'} }
Write-Output ($result | ConvertTo-Json -Depth 6 -Compress)
