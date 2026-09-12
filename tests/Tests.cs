using System;
using System.IO;
using System.IO.Compression;
using System.Threading;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Threading.Tasks;
namespace JourneyLauncher {
 public class Tests {
  static int checks;
  static void Assert(bool yes,string message){checks++;if(!yes)throw new Exception(message);}
  static void Reject(Action action,string message){bool rejected=false;try{action();}catch(InvalidDataException){rejected=true;}Assert(rejected,message);}
  public static int Run(){
   string root=Path.Combine(Path.GetTempPath(),"JourneyLauncher-tests-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(root);
   string report=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"test-results.txt");
   try {
    foreach(string bad in new[]{"../escape.exe","..\\escape.exe","/absolute.exe","C:\\escape.exe","file:stream","CON.exe","dir/../file.exe","foo./file.exe","dir//file.exe"})Reject(()=>Installer.SafePath(root,bad),"Unsafe path accepted: "+bad);
    Assert(Installer.SafePath(root,"bin/game.exe").StartsWith(root),"Valid path rejected");
    Reject(()=>Installer.Location("http://example.com/feed.json"),"Insecure feed accepted");
    using(var client=new HttpClient(new RedirectHandler())) {
     using(var response=Installer.Get(client,new Uri("https://feed.example/release"),new Uri("https://feed.example/release"),"private-token",CancellationToken.None).GetAwaiter().GetResult())Assert(response.StatusCode==HttpStatusCode.OK,"Redirect request failed");
    }
    using(var client=new HttpClient(new DowngradeHandler()))Reject(()=>Installer.Get(client,new Uri("https://feed.example/release"),new Uri("https://feed.example/release"),"private-token",CancellationToken.None).GetAwaiter().GetResult(),"HTTPS downgrade accepted");
    using(var client=new HttpClient(new DeniedHandler())) {
     bool denied=false;try{Installer.Get(client,new Uri("https://feed.example/release"),new Uri("https://feed.example/release"),"private-token",CancellationToken.None).GetAwaiter().GetResult();}catch(UnauthorizedAccessException){denied=true;}Assert(denied,"Unauthorized response accepted");
    }
    string zip=Path.Combine(root,"game.zip");
    using(var z=ZipFile.Open(zip,ZipArchiveMode.Create)){var e=z.CreateEntry("Game.exe");using(var s=e.Open())s.Write(new byte[]{77,90,1,2},0,4);}
    var release=new Release {gameId="warplex-ae",version="test-1",archive="game.zip",sha256=Installer.Hash(zip),size=new FileInfo(zip).Length,unpackedBytes=4,executable="Game.exe",notes="test"};
    string feed=Path.Combine(root,"release.json");Store.Write(feed,release);
    var fetched=Installer.Fetch(feed,null,CancellationToken.None).GetAwaiter().GetResult();Assert(fetched.version=="test-1","Manifest load");
    var progress=new QuietProgress();string destination=Installer.Install(release,feed,null,Path.Combine(root,"games"),progress,CancellationToken.None).GetAwaiter().GetResult();Assert(File.Exists(Path.Combine(destination,"Game.exe")),"Install did not complete");
    Assert(Directory.GetFiles(Path.GetDirectoryName(destination),".download-*").Length==0,"Download was not cleaned up");
    release.version="test-2";
    string updated=Installer.Install(release,feed,null,Path.Combine(root,"games"),progress,CancellationToken.None).GetAwaiter().GetResult();
    Assert(updated!=destination&&File.Exists(Path.Combine(updated,"Game.exe"))&&File.Exists(Path.Combine(destination,"Game.exe")),"Successful update did not preserve previous version");
    release.executable="Missing.exe";
    Reject(()=>Installer.Install(release,feed,null,Path.Combine(root,"games"),progress,CancellationToken.None).GetAwaiter().GetResult(),"Missing executable accepted");
    release.executable="Game.exe";
    release.size++;
    Reject(()=>Installer.Install(release,feed,null,Path.Combine(root,"games"),progress,CancellationToken.None).GetAwaiter().GetResult(),"Incomplete download accepted");
    release.size--;
    release.sha256=new string('0',64);
    Reject(()=>Installer.Install(release,feed,null,Path.Combine(root,"games"),progress,CancellationToken.None).GetAwaiter().GetResult(),"Bad checksum accepted");
    Assert(File.Exists(Path.Combine(destination,"Game.exe")),"Failed update modified current game");
    Assert(Directory.GetDirectories(Path.GetDirectoryName(destination),".staging-*").Length==0,"Failed staging was not removed");
    release.sha256=Installer.Hash(zip);var cancel=new CancellationTokenSource();cancel.Cancel();bool cancelled=false;
    try{Installer.Install(release,feed,null,Path.Combine(root,"games"),progress,cancel.Token).GetAwaiter().GetResult();}catch(OperationCanceledException){cancelled=true;}Assert(cancelled,"Cancel ignored");
    string hostile=Path.Combine(root,"hostile.zip");using(var z=ZipFile.Open(hostile,ZipArchiveMode.Create)){z.CreateEntry("../escaped.exe");}
    Reject(()=>Installer.Extract(hostile,Path.Combine(root,"stage"),1024,progress,CancellationToken.None),"Zip traversal accepted");
    Assert(!File.Exists(Path.Combine(root,"escaped.exe")),"Zip escaped stage");
    Reject(()=>Installer.Extract(zip,Path.Combine(root,"small"),1,progress,CancellationToken.None),"Expansion bound ignored");
    string duplicate=Path.Combine(root,"duplicate.zip");using(var z=ZipFile.Open(duplicate,ZipArchiveMode.Create)){z.CreateEntry("Game.exe");z.CreateEntry("game.exe");}
    Reject(()=>Installer.Extract(duplicate,Path.Combine(root,"dupe"),10,progress,CancellationToken.None),"Duplicate file accepted");
    var invitation=new TesterInvitation {schema=1,gameId="warplex-ae",feed="https://feed.example/v1/games/warplex-ae/release",token=new string('a',43),expires=DateTimeOffset.UtcNow.AddDays(1).ToUnixTimeMilliseconds()};
    TesterInvitation.Validate(invitation);Assert(true,"Valid invitation rejected");
    invitation.expires=1;Reject(()=>TesterInvitation.Validate(invitation),"Expired invitation accepted");invitation.expires=DateTimeOffset.UtcNow.AddDays(1).ToUnixTimeMilliseconds();
    invitation.feed="http://feed.example/release";Reject(()=>TesterInvitation.Validate(invitation),"Insecure invitation accepted");invitation.feed="https://feed.example/release";
    invitation.gameId="another-game";Reject(()=>TesterInvitation.Validate(invitation),"Wrong game invitation accepted");invitation.gameId="warplex-ae";
    invitation.token="short";Reject(()=>TesterInvitation.Validate(invitation),"Invalid invitation key accepted");
    string settings=Path.Combine(root,"settings.json");Store.Write(settings,new Preferences {InstalledVersion="old"});Store.Write(settings,new Preferences {InstalledVersion="new"});Assert(Store.Read<Preferences>(settings).InstalledVersion=="new","Atomic settings replacement");
    string protectedToken=Store.Protect("test-token");Assert(!protectedToken.Contains("test-token")&&Store.Unprotect(protectedToken)=="test-token","Token encryption roundtrip");
    File.WriteAllText(report,"PASS: "+checks+" checks. Local install, failed update preservation, cancellation, paths, archive limits, settings, token encryption.");return 0;
   }catch(Exception ex){File.WriteAllText(report,"FAIL after "+checks+" checks: "+ex);return 1;}
   finally {if(Directory.Exists(root)){Installer.CheckRoot(root);Directory.Delete(root,true);}}
  }
  class RedirectHandler:HttpMessageHandler {
   int count;
   protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct) {
    count++;
    if(count==1) {
     Assert(request.Headers.Authorization!=null&&request.Headers.Authorization.Parameter=="private-token","Missing same-origin token");
     var response=new HttpResponseMessage(HttpStatusCode.Redirect);response.Headers.Location=new Uri("https://storage.example/game.zip");return Task.FromResult(response);
    }
    Assert(request.Headers.Authorization==null,"Token leaked to cross-origin redirect");return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK));
   }
  }
  class DowngradeHandler:HttpMessageHandler {
   protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct) {
    var response=new HttpResponseMessage(HttpStatusCode.Redirect);response.Headers.Location=new Uri("http://storage.example/game.zip");return Task.FromResult(response);
   }
  }
  class DeniedHandler:HttpMessageHandler {
   protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request,CancellationToken ct) {return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Forbidden));}
  }
  class QuietProgress:IProgress<Transfer>{public void Report(Transfer t){}}
 }
}



