using System;
using System.IO;
using System.Diagnostics;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Microsoft.Win32;

namespace JourneyLauncher {
 public class Program {
  static Mutex mutex;
  [STAThread] public static int Main(string[] args) {
   if(args.Length>0&&args[0]=="--self-test")return Tests.Run();
   bool owner;mutex=new Mutex(true,@"Local\JourneyLauncher-"+Environment.UserName,out owner);
   if(!owner){MessageBox.Show("Journey Launcher is already running.");return 0;}
   try {
    if(args.Length==3&&args[0]=="--install-local") {
     string report=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"local-install-results.txt");
     try {
      if(!Installer.Location(args[1]).IsFile)throw new InvalidDataException("This diagnostic command accepts local manifests only.");
      var release=Installer.Fetch(args[1],null,CancellationToken.None).GetAwaiter().GetResult();
      var folder=Installer.Install(release,args[1],null,args[2],new Progress<Transfer>(),CancellationToken.None).GetAwaiter().GetResult();
      string settings=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"JourneyLauncher","settings.json");
      var p=File.Exists(settings)?Store.Read<Preferences>(settings):new Preferences();
      p.InstallRoot=args[2];p.Feed=args[1];p.ManagedDirectory=folder;p.InstalledVersion=release.version;p.InstalledExe=release.executable;p.ExternalExe=null;
      Store.Write(settings,p);File.WriteAllText(report,"PASS: Installed and verified "+release.version+" at "+folder);return 0;
     }catch(Exception ex){File.WriteAllText(report,"FAIL: "+ex);return 1;}
    }
    var app=new Application();var ui=new Launcher();
    if(args.Length==1&&args[0]=="--smoke-play") {
     ui.Window.Loaded+=async(s,e)=>{await ui.SmokePlay();ui.Window.Close();};
    }
    app.DispatcherUnhandledException+=(s,e)=>{MessageBox.Show(e.Exception.Message,"Journey Launcher");e.Handled=true;};
    if(args.Length==2&&args[0]=="--render") {
     ui.Window.Show();ui.Window.UpdateLayout();
     ui.Window.Dispatcher.Invoke(System.Windows.Threading.DispatcherPriority.Render,new Action(()=>{}));
     var bmp=new RenderTargetBitmap((int)ui.Window.ActualWidth,(int)ui.Window.ActualHeight,96,96,PixelFormats.Pbgra32);bmp.Render(ui.Window);
     var encoder=new PngBitmapEncoder();encoder.Frames.Add(BitmapFrame.Create(bmp));using(var f=File.Create(args[1]))encoder.Save(f);ui.Window.Close();return 0;
    }
    if(args.Length==0)ui.Window.Loaded+=async(s,e)=>await ui.CheckOnStart();
    app.Run(ui.Window);return 0;
   } catch(Exception ex){MessageBox.Show(ex.Message,"Launcher could not start");return 1;}
   finally {mutex.ReleaseMutex();mutex.Dispose();}
  }
 }
 public class Launcher {
  public Window Window;
  Preferences prefs;Release available;CancellationTokenSource operation;Process game;bool busy;
  string prefsPath=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"JourneyLauncher","settings.json");
  T Get<T>(string name) where T:class {return Window.FindName(name) as T;}
  public Launcher() {
   using(var s=typeof(Launcher).Assembly.GetManifestResourceStream("MainWindow.xaml"))Window=(Window)XamlReader.Load(s);
   using(var s=typeof(Launcher).Assembly.GetManifestResourceStream("warplex-ae.png")) {var bitmap=new BitmapImage();bitmap.BeginInit();bitmap.CacheOption=BitmapCacheOption.OnLoad;bitmap.StreamSource=s;bitmap.EndInit();Get<Image>("Logo").Source=bitmap;}
   prefs=new Preferences {InstallRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"JourneyGames")};
   if(File.Exists(prefsPath))try{prefs=Store.Read<Preferences>(prefsPath)??prefs;}catch(Exception ex){MessageBox.Show("Settings could not be read. Defaults loaded. "+ex.Message);}
   if(String.IsNullOrEmpty(prefs.InstallRoot))prefs.InstallRoot=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"JourneyGames");
   string bootstrap=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"bootstrap.json");
   if(String.IsNullOrEmpty(prefs.Feed)&&File.Exists(bootstrap))prefs.Feed=Store.Read<Preferences>(bootstrap).Feed;
   Get<Button>("ActionButton").Click+=async(s,e)=>{if(busy){operation.Cancel();return;}if(HasGame()&&(available==null||available.version==prefs.InstalledVersion||!String.IsNullOrEmpty(prefs.ExternalExe)))Play();else await Install();};
   Get<Button>("CheckButton").Click+=async(s,e)=>await Check();
   Get<Button>("SettingsButton").Click+=(s,e)=>Settings();
   Window.Closing+=(s,e)=>{if(busy){operation.Cancel();e.Cancel=true;Get<TextBlock>("Status").Text="Cancelling safely. Close the launcher when cancellation finishes.";}};
   Refresh();
  }
  string Exe(){return !String.IsNullOrEmpty(prefs.ExternalExe)?prefs.ExternalExe:(!String.IsNullOrEmpty(prefs.ManagedDirectory)&&!String.IsNullOrEmpty(prefs.InstalledExe)?Installer.SafePath(prefs.ManagedDirectory,prefs.InstalledExe):null);}
  bool HasGame(){try{return File.Exists(Exe());}catch{return false;}}
  void Save(){Store.Write(prefsPath,prefs);}
  void Refresh() {
   bool running=game!=null&&!game.HasExited;bool has=HasGame();
   Get<Button>("ActionButton").Content=busy?"CANCEL":running?"RUNNING":has?(available!=null&&available.version!=prefs.InstalledVersion&&String.IsNullOrEmpty(prefs.ExternalExe)?"UPDATE":"PLAY"):"INSTALL";
   Get<Button>("ActionButton").IsEnabled=!running;
   Get<Button>("CheckButton").IsEnabled=!busy&&!running;
   Get<Button>("SettingsButton").IsEnabled=!busy&&!running;
   Get<TextBlock>("StateLabel").Text=busy?"Preparing your game":running?"Game is running":has?"Ready to play":"Ready to install";
   Get<TextBlock>("VersionLabel").Text=has?(!String.IsNullOrEmpty(prefs.ExternalExe)?"Linked local build": "Installed · "+prefs.InstalledVersion):"Not installed";
   Get<TextBlock>("AccessLabel").Text=String.IsNullOrEmpty(prefs.Feed)||!prefs.Feed.StartsWith("https://",StringComparison.OrdinalIgnoreCase)?"LOCAL PREVIEW":"PRIVATE TESTER FEED";
   if(!busy)Get<TextBlock>("Status").Text=has?"Warplex AE is available on this computer.":String.IsNullOrEmpty(prefs.Feed)?"Choose an installation source in Settings.":"Install from your configured release manifest.";
  }
  void Begin(){busy=true;operation=new CancellationTokenSource();Refresh();Get<ProgressBar>("Progress").Value=0;}
  void End(){busy=false;operation.Dispose();operation=null;Refresh();}
  string Token(){return Store.Unprotect(prefs.ProtectedToken);}
  void ShowRelease(){Get<TextBlock>("ReleaseTitle").Text="Release "+available.version;Get<TextBlock>("Notes").Text=String.IsNullOrWhiteSpace(available.notes)?"No patch notes were provided for this release.":available.notes;}
  public async Task CheckOnStart(){if(!String.IsNullOrEmpty(prefs.Feed))await Check();}
  async Task Check() {
   Begin();string result;
   try {Get<TextBlock>("Status").Text="Checking release manifest…";available=await Installer.Fetch(prefs.Feed,Token(),operation.Token);ShowRelease();result=!String.IsNullOrEmpty(prefs.ExternalExe)?"Release found. Unlink your local build in Settings to install it.":available.version==prefs.InstalledVersion?"You have the current release.":"Release "+available.version+" is available.";}
   catch(OperationCanceledException){result="Update check cancelled.";}
   catch(Exception ex){available=null;result=ex.Message;}
   End();Get<TextBlock>("Status").Text=result;
  }
  async Task Install() {
   Begin();string result;
   try {
    Get<TextBlock>("Status").Text="Reading release manifest…";
    available=await Installer.Fetch(prefs.Feed,Token(),operation.Token);ShowRelease();
    var progress=new Progress<Transfer>(p=>{Get<TextBlock>("Status").Text=p.Message;Get<ProgressBar>("Progress").Value=p.Percent;});
    string installed=await Installer.Install(available,prefs.Feed,Token(),prefs.InstallRoot,progress,operation.Token);
    var next=new Preferences {InstallRoot=prefs.InstallRoot,Feed=prefs.Feed,ProtectedToken=prefs.ProtectedToken,AccessExpires=prefs.AccessExpires,TesterId=prefs.TesterId,ManagedDirectory=installed,InstalledVersion=available.version,InstalledExe=available.executable};
    Store.Write(prefsPath,next);prefs=next;result="Installation complete. Ready to play.";
   } catch(OperationCanceledException){result="Cancelled. Your previous installation is unchanged.";}
   catch(Exception ex){result=ex.Message;}
   End();Get<TextBlock>("Status").Text=result;
  }
  void Play() {
   try {
    string exe=Exe();if(!File.Exists(exe))throw new FileNotFoundException("Game executable is missing. Reinstall or link the build again.");
    game=Process.Start(new ProcessStartInfo(exe) {WorkingDirectory=Path.GetDirectoryName(exe),UseShellExecute=false});
    game.EnableRaisingEvents=true;game.Exited+=(s,e)=>Window.Dispatcher.BeginInvoke(new Action(()=>{game.Dispose();game=null;Refresh();}));Refresh();
   } catch(Exception ex){Get<TextBlock>("Status").Text=ex.Message;}
  }
  public async Task SmokePlay() {
   string result="FAIL: game did not start";
   try {
    Get<Button>("ActionButton").RaiseEvent(new RoutedEventArgs(Button.ClickEvent));
    for(int wait=0;wait<120;wait++) {
     await Task.Delay(500);
     if(game==null||game.HasExited)break;game.Refresh();
     if(game.MainWindowHandle!=IntPtr.Zero&&!String.IsNullOrEmpty(game.MainWindowTitle))break;
    }
    if(game!=null&&!game.HasExited&&game.MainWindowHandle!=IntPtr.Zero) {
     result="PASS: Play button started process "+game.Id+" ("+game.MainWindowTitle+") from "+Exe();
     game.CloseMainWindow();
    }
   }catch(Exception ex){result="FAIL: "+ex.Message;}
   File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"play-smoke-results.txt"),result);
  }
  void Settings() {
   var dialog=new Window {Title="Launcher settings",Owner=Window,Width=650,Height=600,ResizeMode=ResizeMode.NoResize,WindowStartupLocation=WindowStartupLocation.CenterOwner,Background=new SolidColorBrush(Color.FromRgb(18,25,35)),Foreground=Brushes.White,FontFamily=new FontFamily("Segoe UI")};
   var panel=new StackPanel {Margin=new Thickness(26)};dialog.Content=new ScrollViewer {Content=panel,VerticalScrollBarVisibility=ScrollBarVisibility.Auto};
   panel.Children.Add(new TextBlock {Text="Installation & tester access",FontSize=23,Margin=new Thickness(0,0,0,18)});
   var root=Field(panel,"Install folder for future installations",prefs.InstallRoot);
   var browse=new Button {Content="Browse folder…",HorizontalAlignment=HorizontalAlignment.Left,Margin=new Thickness(0,5,0,12)};
   browse.Click+=(s,e)=>{using(var picker=new System.Windows.Forms.FolderBrowserDialog {SelectedPath=root.Text,Description="Choose where Journey Launcher installs games"})if(picker.ShowDialog()==System.Windows.Forms.DialogResult.OK)root.Text=picker.SelectedPath;};panel.Children.Add(browse);
   var feed=Field(panel,"Update manifest (HTTPS URL or local JSON file)",prefs.Feed);
   panel.Children.Add(new TextBlock {Text="Only use a feed supplied by the game owner. Packages contain executable software.",Foreground=Brushes.LightSlateGray,FontSize=11,Margin=new Thickness(0,5,0,12),TextWrapping=TextWrapping.Wrap});
   panel.Children.Add(new TextBlock {Text="Tester token (optional, encrypted for this Windows user)",Margin=new Thickness(0,0,0,5)});
   var token=new PasswordBox {Padding=new Thickness(8)};try{token.Password=Token()??"";}catch{token.Password="";}panel.Children.Add(token);
   long accessExpires=prefs.AccessExpires;string testerId=prefs.TesterId;string credentialFeed=prefs.Feed;
   var accessInfo=new TextBlock {Text=accessExpires>0?"Invitation expires "+DateTimeOffset.FromUnixTimeMilliseconds(accessExpires).LocalDateTime.ToString("g"):"Import a private invitation file from the game owner.",Foreground=Brushes.LightSlateGray,FontSize=11,Margin=new Thickness(0,7,0,7),TextWrapping=TextWrapping.Wrap};
   panel.Children.Add(accessInfo);
   var importInvite=new Button {Content="Import tester invitation…",HorizontalAlignment=HorizontalAlignment.Left,Padding=new Thickness(10,6,10,6)};
   importInvite.Click+=(s,e)=>{var picker=new OpenFileDialog {Filter="Tester invitation (*.json)|*.json",Title="Choose the invitation supplied by the game owner"};if(picker.ShowDialog(dialog)==true)try {
    var invitation=TesterInvitation.Read(picker.FileName);feed.Text=invitation.feed;token.Password=invitation.token;accessExpires=invitation.expires;testerId=invitation.testerId;credentialFeed=invitation.feed;
    accessInfo.Text="Invitation loaded. Expires "+DateTimeOffset.FromUnixTimeMilliseconds(accessExpires).LocalDateTime.ToString("g")+". Review the feed above, then save settings.";
   }catch(Exception ex){MessageBox.Show(dialog,ex.Message,"Invitation could not be imported");}};panel.Children.Add(importInvite);
   var linked=new TextBlock {Text=String.IsNullOrEmpty(prefs.ExternalExe)?"No linked local executable":prefs.ExternalExe,TextWrapping=TextWrapping.Wrap,FontSize=11,Margin=new Thickness(0,16,0,5)};panel.Children.Add(linked);
   string selectedExe=prefs.ExternalExe;var row=new StackPanel {Orientation=Orientation.Horizontal};
   var link=new Button {Content="Link existing game…",Margin=new Thickness(0,0,10,0)};link.Click+=(s,e)=>{var file=new OpenFileDialog {Filter="Windows game (*.exe)|*.exe",Title="Select Warplex AE executable"};if(file.ShowDialog(dialog)==true){selectedExe=file.FileName;linked.Text=selectedExe;}};row.Children.Add(link);
   var unlink=new Button {Content="Unlink"};unlink.Click+=(s,e)=>{selectedExe=null;linked.Text="No linked local executable";};row.Children.Add(unlink);panel.Children.Add(row);
   panel.Children.Add(new TextBlock {Text="Changing the install folder affects the next install or update. Existing files stay where they are. Tester invitations grant private downloads until expired or revoked. Keep invitation files private.",Foreground=Brushes.LightSlateGray,FontSize=11,TextWrapping=TextWrapping.Wrap,Margin=new Thickness(0,14,0,14)});
   var save=new Button {Content="Save settings",Padding=new Thickness(16,9,16,9),HorizontalAlignment=HorizontalAlignment.Right};save.Click+=(s,e)=>{try {
    if(String.IsNullOrWhiteSpace(root.Text)||!Path.IsPathRooted(root.Text))throw new InvalidDataException("Choose an absolute installation folder.");Installer.CheckRoot(root.Text);
    if(!String.IsNullOrWhiteSpace(feed.Text))Installer.Location(feed.Text.Trim());
    if(!String.IsNullOrEmpty(token.Password)&&!String.IsNullOrEmpty(credentialFeed)) {
     var previous=Installer.Location(credentialFeed);var chosen=Installer.Location(feed.Text.Trim());
     if(previous.GetLeftPart(UriPartial.Authority)!=chosen.GetLeftPart(UriPartial.Authority))throw new InvalidDataException("Import an invitation for the new server, or clear the existing tester key before changing servers.");
    }
    var next=new Preferences {InstallRoot=Path.GetFullPath(root.Text),Feed=feed.Text.Trim(),ProtectedToken=Store.Protect(token.Password),AccessExpires=accessExpires,TesterId=testerId,ExternalExe=selectedExe,ManagedDirectory=prefs.ManagedDirectory,InstalledVersion=prefs.InstalledVersion,InstalledExe=prefs.InstalledExe};
    Store.Write(prefsPath,next);prefs=next;available=null;Refresh();dialog.Close();
   }catch(Exception ex){MessageBox.Show(dialog,ex.Message,"Settings could not be saved");}};panel.Children.Add(save);dialog.ShowDialog();
  }
  static TextBox Field(Panel panel,string title,string value){panel.Children.Add(new TextBlock {Text=title,Margin=new Thickness(0,0,0,5)});var box=new TextBox {Text=value??"",Padding=new Thickness(8)};panel.Children.Add(box);return box;}
 }
}






