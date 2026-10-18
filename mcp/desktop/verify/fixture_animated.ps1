# c024 test fixture: a window that KEEPS MOVING. Its element tree is readable and mostly stable
# (the controls do not change), but the pixels never settle - the animated bar and the ticker
# change on a timer. That is exactly the case a single-signal quiescence check gets wrong, and
# the case the acceptance suite could not test before (it used to be an honest SKIP).
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'C024-ANIMATED'
$form.Width = 460
$form.Height = 220
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

$label = New-Object System.Windows.Forms.Label
$label.Name = 'c024label'
$label.AccessibleName = 'c024label'
$label.Text = 'frame 0000'
$label.Top = 20
$label.Left = 20
$label.Width = 400
$form.Controls.Add($label)

$bar = New-Object System.Windows.Forms.ProgressBar
$bar.Name = 'c024bar'
$bar.AccessibleName = 'c024bar'
$bar.Top = 60
$bar.Left = 20
$bar.Width = 400
$bar.Height = 28
$bar.Minimum = 0
$bar.Maximum = 100
$form.Controls.Add($bar)

$canvas = New-Object System.Windows.Forms.Panel
$canvas.Top = 100
$canvas.Left = 20
$canvas.Width = 400
$canvas.Height = 70
$canvas.BackColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
$form.Controls.Add($canvas)

$script:frame = 0
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 80
$timer.Add_Tick({
    $script:frame = ($script:frame + 1) % 1000
    $label.Text = 'frame {0:D4}' -f $script:frame
    $bar.Value = $script:frame % 101
    # move a small square so the pixels change even where text is not rendered
    $graphics = $canvas.CreateGraphics()
    $graphics.Clear([System.Drawing.Color]::FromArgb(30, 30, 30))
    $brush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 214, 0))
    $graphics.FillRectangle($brush, ($script:frame * 3) % 360, 20, 36, 36)
    $brush.Dispose()
    $graphics.Dispose()
})
$form.Add_Shown({ $timer.Start(); $form.Activate() })
$form.Add_FormClosed({ $timer.Stop() })
$form.ShowDialog() | Out-Null
