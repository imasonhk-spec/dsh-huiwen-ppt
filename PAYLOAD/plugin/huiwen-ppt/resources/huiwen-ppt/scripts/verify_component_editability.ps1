param([string]$Source,[string]$Destination,[string]$Report,[ValidateSet('edit','reopen')][string]$Phase='edit')
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$sourceHash=(Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLower()
if($Phase -eq 'edit'){
 if(Test-Path -LiteralPath $Destination){throw 'Test copy exists'}
 Copy-Item -LiteralPath $Source -Destination $Destination
}
$app=New-Object -ComObject KWPP.Application
$deck=$null
try{
 $deck=$app.Presentations.Open($Destination,0,0,0)
 if($null -eq $deck){throw 'WPS open failed'}
 if($Phase -eq 'edit'){
  $probes=@();$overflow=@()
  for($p=1;$p -le $deck.Slides.Count;$p++){
   for($i=1;$i -le $deck.Slides.Item($p).Shapes.Count;$i++){
    $shape=$deck.Slides.Item($p).Shapes.Item($i)
    if($shape.HasTextFrame -eq -1 -and $shape.TextFrame.HasText -eq -1){
     try{
      $h=[double]$shape.TextFrame.TextRange.BoundHeight
      $w=[double]$shape.TextFrame.TextRange.BoundWidth
      if($h -gt [double]$shape.Height+3 -or $w -gt [double]$shape.Width+3){$overflow+=@{page=$p;index=$i;text=[string]$shape.TextFrame.TextRange.Text;bound_width=$w;bound_height=$h;width=[double]$shape.Width;height=[double]$shape.Height}}
     }catch{}
     if(-not ($probes | Where-Object {$_.kind -eq 'text'})){
      $shape.TextFrame.TextRange.Text='COMPONENT EDIT CHECK';$left=[double]$shape.Left+1;$shape.Left=$left
      $probes+=@{kind='text';page=$p;index=$i;value='COMPONENT EDIT CHECK';left=$left}
     }
    }
    if($shape.HasTable -eq -1 -and -not ($probes | Where-Object {$_.kind -eq 'table'})){
     $shape.Table.Cell(2,2).Shape.TextFrame.TextRange.Text='TABLE EDIT CHECK'
     $probes+=@{kind='table';page=$p;index=$i;value='TABLE EDIT CHECK'}
    }
    if($shape.HasChart -eq -1 -and -not ($probes | Where-Object {$_.kind -eq 'chart'})){
     $width=[double]$shape.Width-1;$shape.Width=$width;$probes+=@{kind='chart';page=$p;index=$i;width=$width}
    }
    if($shape.Connector -eq -1 -and -not ($probes | Where-Object {$_.kind -eq 'connector'})){
     $weight=[double]$shape.Line.Weight+0.25;$shape.Line.Weight=$weight;$probes+=@{kind='connector';page=$p;index=$i;weight=$weight}
    }
   }
  }
  if(-not ($probes | Where-Object {$_.kind -eq 'text'})){throw 'No editable text found'}
  $deck.Save()
  $result=@{status='saved_reopen_pending';source_sha256=$sourceHash;engine='wps';version=[string]$app.Version;probes=$probes;overflow_candidates=$overflow;test_copy=$Destination;chart_data_edit_in_wps='not_tested';powerpoint='not_verified'}
 }else{
  $saved=Get-Content -Raw -LiteralPath $Report | ConvertFrom-Json
  $result=@{}
  foreach($property in $saved.PSObject.Properties){$result[$property.Name]=$property.Value}
  if($result.source_sha256 -ne $sourceHash){throw 'Source changed'}
  foreach($probe in $result.probes){
   $shape=$deck.Slides.Item($probe.page).Shapes.Item($probe.index)
   switch($probe.kind){
    'text' {if($shape.TextFrame.TextRange.Text -ne $probe.value -or [Math]::Abs([double]$shape.Left-$probe.left) -gt 0.1){throw 'Text/position edit lost'}}
    'table' {if($shape.HasTable -ne -1 -or $shape.Table.Cell(2,2).Shape.TextFrame.TextRange.Text -ne $probe.value){throw 'Table edit lost'}}
    'chart' {if($shape.HasChart -ne -1 -or [Math]::Abs([double]$shape.Width-$probe.width) -gt 0.1){throw 'Chart resize lost'}}
    'connector' {if($shape.Connector -ne -1 -or [Math]::Abs([double]$shape.Line.Weight-$probe.weight) -gt 0.1){throw 'Connector edit lost'}}
   }
  }
  $result.status='passed';$result.reopen='fresh_wps_instance';$result.source_unchanged=$true
 }
 if((Get-FileHash -LiteralPath $Source -Algorithm SHA256).Hash.ToLower() -ne $sourceHash){throw 'Source changed'}
 [System.IO.File]::WriteAllText($Report,($result|ConvertTo-Json -Depth 8),[System.Text.UTF8Encoding]::new($false))
 Write-Output ($result|ConvertTo-Json -Depth 8)
}finally{
 if($null -ne $deck){try{$deck.Close()}catch{};try{[System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($deck)|Out-Null}catch{}}
 try{[System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($app)|Out-Null}catch{}
}
