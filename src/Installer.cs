using System;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Collections.Generic;

namespace JourneyLauncher {
 public class Release {
  public string gameId {get;set;}
  public string version {get;set;}
  public string archive {get;set;}
  public string sha256 {get;set;}
  public long size {get;set;}
  public long unpackedBytes {get;set;}
  public string executable {get;set;}
  public string notes {get;set;}
 }
  public class TesterInvitation {
  public int schema {get;set;}
  public string gameId {get;set;}
  public string testerId {get;set;}
  public string name {get;set;}
  public long expires {get;set;}
  public string feed {get;set;}
  public string token {get;set;}
  public static TesterInvitation Read(string path) {
   if(new FileInfo(path).Length>16384)throw new InvalidDataException("Invitation file is too large.");
   var invite=Store.Read<TesterInvitation>(path);Validate(invite);return invite;
  }
  public static void Validate(TesterInvitation invite) {
   if(invite==null||invite.schema!=1||invite.gameId!="warplex-ae")throw new InvalidDataException("This invitation is not for Warplex AE.");
   var uri=Installer.Location(invite.feed);
   if(uri.Scheme!="https"||!String.IsNullOrEmpty(uri.Fragment)||!String.IsNullOrEmpty(uri.Query))throw new InvalidDataException("An invitation must use a secure HTTPS feed.");
   if(invite.token==null||!Regex.IsMatch(invite.token,@"\A[A-Za-z0-9_-]{43,128}\z"))throw new InvalidDataException("Invalid tester access key.");
   if(invite.expires<=DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())throw new InvalidDataException("This invitation has expired. Request a new invitation from the game owner.");
  }
 }
 public class Preferences {
  public string InstallRoot {get;set;}
  public long AccessExpires {get;set;}
  public string TesterId {get;set;}
  public string Feed {get;set;}
  public string ProtectedToken {get;set;}
  public string ExternalExe {get;set;}
  public string ManagedDirectory {get;set;}
  public string InstalledVersion {get;set;}
  public string InstalledExe {get;set;}
 }
 public class Transfer {
  public string Message; public double Percent;
  public Transfer(string m,double p){Message=m;Percent=p;}
 }
 public static class Store {
  public static readonly JavaScriptSerializer Json = new JavaScriptSerializer {MaxJsonLength=1048576};
  public static void Write(string path,object value) {
   Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(path)));
   string temporary=path+"."+Guid.NewGuid().ToString("N")+".tmp";
   try {
    using(var f=new FileStream(temporary,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {
     byte[] b=Encoding.UTF8.GetBytes(Json.Serialize(value)); f.Write(b,0,b.Length); f.Flush(true);
    }
    if(File.Exists(path)) File.Replace(temporary,path,null); else File.Move(temporary,path);
   } finally { if(File.Exists(temporary)) File.Delete(temporary); }
  }
  public static T Read<T>(string path) {return Json.Deserialize<T>(File.ReadAllText(path));}
  public static string Protect(string token) {return String.IsNullOrWhiteSpace(token)?null:Convert.ToBase64String(ProtectedData.Protect(Encoding.UTF8.GetBytes(token),null,DataProtectionScope.CurrentUser));}
  public static string Unprotect(string token) {return String.IsNullOrEmpty(token)?null:Encoding.UTF8.GetString(ProtectedData.Unprotect(Convert.FromBase64String(token),null,DataProtectionScope.CurrentUser));}
 }
 public class Installer {
  public const long MaxArchive=20L*1024*1024*1024;
  public const long MaxExpanded=60L*1024*1024*1024;
  static bool SameOrigin(Uri a,Uri b){return a.Scheme==b.Scheme && a.Host==b.Host && a.Port==b.Port;}
  public static Uri Location(string input) {
   if(String.IsNullOrWhiteSpace(input)) throw new InvalidDataException("Set an update manifest in Settings first.");
   Uri uri;
   if(Path.IsPathRooted(input) && !input.StartsWith("https:",StringComparison.OrdinalIgnoreCase)) uri=new Uri(Path.GetFullPath(input));
   else if(!Uri.TryCreate(input,UriKind.Absolute,out uri)) throw new InvalidDataException("Use a full HTTPS URL or local manifest path.");
   if(uri.Scheme!="https" && !uri.IsFile) throw new InvalidDataException("Update servers must use HTTPS.");
   if(!String.IsNullOrEmpty(uri.UserInfo)) throw new InvalidDataException("Do not put credentials in a URL.");
   if(uri.IsUnc) throw new InvalidDataException("Copy network-share manifests locally first.");
   return uri;
  }
  internal static async Task<HttpResponseMessage> Get(HttpClient client,Uri uri,Uri origin,string token,CancellationToken ct) {
   for(int redirect=0;redirect<6;redirect++) {
    if(uri.Scheme!="https") throw new InvalidDataException("An update URL redirected away from HTTPS.");
    using(var req=new HttpRequestMessage(HttpMethod.Get,uri)) {
     if(!String.IsNullOrEmpty(token) && SameOrigin(origin,uri)) req.Headers.Authorization=new AuthenticationHeaderValue("Bearer",token);
     var response=await client.SendAsync(req,HttpCompletionOption.ResponseHeadersRead,ct);
     int code=(int)response.StatusCode;
     if(code==301||code==302||code==303||code==307||code==308) {
      Uri next=response.Headers.Location; response.Dispose();
      if(next==null) throw new InvalidDataException("Update server returned an empty redirect.");
      uri=next.IsAbsoluteUri?next:new Uri(uri,next); continue;
     }
     if(code==401||code==403) {response.Dispose();throw new UnauthorizedAccessException("Tester access was denied. Check your token or ask the game owner for access.");}
     try {response.EnsureSuccessStatusCode();return response;} catch {response.Dispose();throw;}
    }
   }
   throw new InvalidDataException("Too many update redirects.");
  }
  static HttpClient Client(){return new HttpClient(new HttpClientHandler {AllowAutoRedirect=false}) {Timeout=TimeSpan.FromMinutes(30)};}
  static async Task Copy(Stream source,Stream target,long limit,long expected,IProgress<Transfer> progress,CancellationToken ct) {
   byte[] buffer=new byte[131072];long total=0; int count;
   while((count=await source.ReadAsync(buffer,0,buffer.Length,ct))>0) {
    total+=count;if(total>limit)throw new InvalidDataException("Download exceeds the declared size limit.");
    await target.WriteAsync(buffer,0,count,ct);
    if(progress!=null) progress.Report(new Transfer("Downloading · "+(total/1048576.0).ToString("0.0")+" / "+(expected/1048576.0).ToString("0.0")+" MB",expected>0?total*80.0/expected:0));
   }
   if(expected>0&&total!=expected)throw new InvalidDataException("Download was incomplete. Please retry.");
  }
  public static async Task<Release> Fetch(string feed,string token,CancellationToken ct) {
   Uri uri=Location(feed);string json;
   if(uri.IsFile) {if(new FileInfo(uri.LocalPath).Length>1048576) throw new InvalidDataException("Manifest is too large.");json=File.ReadAllText(uri.LocalPath);}
   else using(var client=Client()) using(var response=await Get(client,uri,uri,token,ct)) using(var stream=await response.Content.ReadAsStreamAsync()) using(var memory=new MemoryStream()) {
    await Copy(stream,memory,1048576,0,null,ct);json=Encoding.UTF8.GetString(memory.ToArray());
   }
   Release r=Store.Json.Deserialize<Release>(json); Validate(r,uri);return r;
  }
  public static void Validate(Release r,Uri feed) {
   if(r==null||r.gameId!="warplex-ae")throw new InvalidDataException("This manifest is not for Warplex AE.");
   if(String.IsNullOrWhiteSpace(r.version)||!Regex.IsMatch(r.version,@"\A[A-Za-z0-9][A-Za-z0-9._-]{0,63}\z"))throw new InvalidDataException("Invalid release version.");
   if(r.sha256==null||!Regex.IsMatch(r.sha256,@"\A[0-9a-fA-F]{64}\z"))throw new InvalidDataException("Release requires a SHA-256 checksum.");
   if(r.size<=0||r.size>MaxArchive||r.unpackedBytes<=0||r.unpackedBytes>MaxExpanded)throw new InvalidDataException("Invalid release size limits.");
   SafePath(Path.Combine(Path.GetTempPath(),"launcher-validation"),r.executable);
   if(!r.executable.EndsWith(".exe",StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Release entry point must be a Windows executable.");
   ArchiveLocation(r,feed);
  }
  static Uri ArchiveLocation(Release r,Uri feed) {
   if(String.IsNullOrWhiteSpace(r.archive))throw new InvalidDataException("Release is missing its archive.");
   Uri uri=new Uri(feed,r.archive);
   if(feed.IsFile) {if(!uri.IsFile&&uri.Scheme!="https")throw new InvalidDataException("Archive must be local or HTTPS.");}
   else if(uri.Scheme!="https")throw new InvalidDataException("A remote manifest must use an HTTPS archive.");
   if(uri.IsUnc||!String.IsNullOrEmpty(uri.UserInfo))throw new InvalidDataException("Invalid archive location.");
   return uri;
  }
  public static string SafePath(string root,string relative) {
   if(String.IsNullOrWhiteSpace(relative)||Path.IsPathRooted(relative)||relative.Contains(":"))throw new InvalidDataException("Unsafe package path.");
   string normalized=relative.Replace('\\','/').TrimEnd('/');
   foreach(string part in normalized.Split('/')) {
    if(part=="."||part==".."||part.Length==0||part.EndsWith(".")||part.EndsWith(" ")||part.IndexOfAny(Path.GetInvalidFileNameChars())>=0||Regex.IsMatch(part,@"\A(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)",RegexOptions.IgnoreCase))throw new InvalidDataException("Unsafe package path: "+relative);
   }
   string basePath=Path.GetFullPath(root).TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar;
   string full=Path.GetFullPath(Path.Combine(basePath,normalized.Replace('/',Path.DirectorySeparatorChar)));
   if(!full.StartsWith(basePath,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Package path escapes installation folder.");
   return full;
  }
  public static void CheckRoot(string root) {
   string full=Path.GetFullPath(root);
   if(full.StartsWith(@"\\"))throw new InvalidDataException("Choose a local installation folder.");
   for(DirectoryInfo d=new DirectoryInfo(full);d!=null;d=d.Parent) if(d.Exists&&(d.Attributes&FileAttributes.ReparsePoint)!=0)throw new InvalidDataException("Installation folders cannot contain symbolic links or junctions.");
  }
  public static string Hash(string path) {using(var sha=SHA256.Create())using(var s=File.OpenRead(path))return BitConverter.ToString(sha.ComputeHash(s)).Replace("-","").ToLowerInvariant();}
  public static async Task<string> Install(Release r,string feed,string token,string root,IProgress<Transfer> progress,CancellationToken ct) {
   Uri origin=Location(feed);Validate(r,origin);CheckRoot(root);
   string versions=Path.Combine(Path.GetFullPath(root),"WarplexAE","releases");
   Directory.CreateDirectory(versions);CheckRoot(versions);
   var disk=new DriveInfo(Path.GetPathRoot(versions));
   if(disk.AvailableFreeSpace<r.size+r.unpackedBytes+64*1024*1024)throw new IOException("Not enough free disk space for this release.");
   string id=Guid.NewGuid().ToString("N"),stage=Path.Combine(versions,".staging-"+id),archive=Path.Combine(versions,".download-"+id+".zip");
   string destination=Path.Combine(versions,r.version+"-"+id);
   Directory.CreateDirectory(stage);
   try {
    Uri uri=ArchiveLocation(r,origin);
    for(int attempt=0;;attempt++) {
     try {
      using(var output=new FileStream(archive,FileMode.Create,FileAccess.Write,FileShare.None,131072,true)) {
       if(uri.IsFile)using(var input=File.OpenRead(uri.LocalPath))await Copy(input,output,r.size,r.size,progress,ct);
       else using(var client=Client())using(var response=await Get(client,uri,origin,token,ct))using(var input=await response.Content.ReadAsStreamAsync())await Copy(input,output,r.size,r.size,progress,ct);
      } break;
     } catch(HttpRequestException) {if(attempt>=2)throw;}
     await Task.Delay(1000*(attempt+1),ct);
    }
    ct.ThrowIfCancellationRequested();progress.Report(new Transfer("Verifying SHA-256…",82));
    string hash=await Task.Run(()=>Hash(archive));ct.ThrowIfCancellationRequested();
    if(!String.Equals(hash,r.sha256,StringComparison.OrdinalIgnoreCase))throw new InvalidDataException("Checksum mismatch. The existing installation has been preserved.");
    await Task.Run(()=>Extract(archive,stage,r.unpackedBytes,progress,ct),ct);
    string exe=SafePath(stage,r.executable);
    if(!File.Exists(exe))throw new InvalidDataException("Package is missing its executable.");
    using(var f=File.OpenRead(exe))if(f.ReadByte()!=77||f.ReadByte()!=90)throw new InvalidDataException("Entry point is not a Windows executable.");
    Store.Write(Path.Combine(stage,".launcher-release.json"),r);
    ct.ThrowIfCancellationRequested();Directory.Move(stage,destination);
    progress.Report(new Transfer("Installation verified",100));return destination;
   } finally {
    if(File.Exists(archive))File.Delete(archive);
    if(Directory.Exists(stage)) {CheckRoot(stage);Directory.Delete(stage,true);}
   }
  }
  public static void Extract(string archive,string stage,long maxBytes,IProgress<Transfer> progress,CancellationToken ct) {
   using(var zip=ZipFile.OpenRead(archive)) {
    if(zip.Entries.Count>100000)throw new InvalidDataException("Too many files in package.");
    long total=0;var paths=new HashSet<string>(StringComparer.OrdinalIgnoreCase);int index=0;
    foreach(var entry in zip.Entries) {
     ct.ThrowIfCancellationRequested();string path=SafePath(stage,entry.FullName);
     if(!paths.Add(path))throw new InvalidDataException("Duplicate package path.");
     int kind=(entry.ExternalAttributes>>16)&0xF000;
     if(kind!=0&&kind!=0x8000&&kind!=0x4000)throw new InvalidDataException("Package contains a link or special file.");
     total=checked(total+entry.Length);if(total>maxBytes)throw new InvalidDataException("Package expands beyond its declared size.");
     if(entry.FullName.EndsWith("/"))Directory.CreateDirectory(path);
     else {
      Directory.CreateDirectory(Path.GetDirectoryName(path));
      using(var input=entry.Open())using(var output=new FileStream(path,FileMode.CreateNew)) {
       byte[] buffer=new byte[131072];int count;long written=0;
       while((count=input.Read(buffer,0,buffer.Length))>0) {ct.ThrowIfCancellationRequested();written+=count;if(written>entry.Length)throw new InvalidDataException("Invalid expanded file length.");output.Write(buffer,0,count);}
       if(written!=entry.Length)throw new InvalidDataException("Incomplete package entry.");
      }
     }
     index++;progress.Report(new Transfer("Installing files · "+index+" / "+zip.Entries.Count,85+index*14.0/zip.Entries.Count));
    }
   }
  }
 }
}
