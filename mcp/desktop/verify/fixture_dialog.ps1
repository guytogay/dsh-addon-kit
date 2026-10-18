# c021 test fixture: a window this test owns, with a real Edit control (UIA ValuePattern).
# A Run dialog would have been lighter but it does not open on this host; a Notepad window is
# not addressable (its editor exposes neither ValuePattern nor TextPattern) and a Notepad that
# is already running belongs to the user. This fixture is disposable and cannot touch data.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = 'C021-FIXTURE'
$form.Width = 420
$form.Height = 160
$form.StartPosition = 'CenterScreen'
$form.TopMost = $true

$box = New-Object System.Windows.Forms.TextBox
$box.Name = 'c021box'
$box.AccessibleName = 'c021box'
$box.Width = 360
$box.Top = 20
$box.Left = 20
$form.Controls.Add($box)

$label = New-Object System.Windows.Forms.Label
$label.Text = 'c021 type-verification fixture'
$label.Top = 60
$label.Left = 20
$label.Width = 360
$form.Controls.Add($label)

$form.Add_Shown({ $form.Activate(); $box.Focus() })
$form.ShowDialog() | Out-Null
