/**
 * POSIX shell program for remote workspace files, commands and Git, run over the existing authenticated SSH transport.
 * It needs only `sh`, standard utilities and sha256sum, shasum or openssl, so hosts without Node.js work too.
 */
export const WORKSPACE_SHELL = `
# Inputs, assigned before this program: dsh_op, dsh_cwd, dsh_path, dsh_parent, dsh_base and per-operation values.
# Output: "ok" and the operation's data, or "error <status> <message>". Handled errors exit 0.
unset CDPATH IFS
dsh_nl='
'
dsh_tmp= dsh_mine= dsh_t= dsh_job= dsh_group= dsh_stat_kind=
dsh_fail() { printf 'error %s %s\\n' "$1" "$2"; exit 0; }
# A command and every process it started; without a process group they are found through their parents.
dsh_tree() {
  printf '%s\\n' "$1"
  for dsh_child in $(ps -A -o pid= -o ppid= 2>/dev/null | awk -v p="$1" '$2 == p { print $1 }'); do dsh_tree "$dsh_child"; done
}
dsh_kill() {
  if [ -n "$dsh_group" ] && kill -s KILL -- "-$dsh_job" 2>/dev/null; then return 0; fi
  kill -s STOP $(dsh_tree "$dsh_job") 2>/dev/null
  kill -s KILL $(dsh_tree "$dsh_job") 2>/dev/null
}
dsh_cleanup() {
  [ -z "$dsh_job" ] || dsh_kill
  [ -z "$dsh_tmp" ] || rm -f "$dsh_tmp"
  [ -z "$dsh_mine" ] || rm -f "$dsh_mine"
  [ -z "$dsh_t" ] || rm -rf "$dsh_t"
}
trap dsh_cleanup 0
trap 'exit 1' 1 2 13 15
# Physical path of a directory, exact even when it ends with a newline.
dsh_real() {
  dsh_real_path=$(cd -P "$1" 2>/dev/null && pwd -P && printf x) || return 1
  dsh_real_path=\${dsh_real_path%?x}
}
dsh_join() { if [ "$1" = / ]; then dsh_joined=/$2; else dsh_joined=$1/$2; fi; }
dsh_under() { [ "$1" = / ] || [ "$2" = "$1" ] || case $2 in "$1"/*) true ;; *) false ;; esac; }
# Sets dsh_file and its physical parent dsh_dir from a normalized relative path, its parent and its last component.
# Directories, including links to them, must resolve inside the workspace; operations refuse other links.
dsh_resolve() {
  if [ -z "$1" ]; then dsh_file=$dsh_root dsh_dir=$dsh_root; return 0; fi
  if [ -z "$2" ]; then dsh_dir=$dsh_root
  else
    dsh_join "$dsh_root" "$2"
    dsh_real "$dsh_joined" || dsh_fail 404 'No such file or directory'
    dsh_under "$dsh_root" "$dsh_real_path" || dsh_fail 403 'Path is outside the remote workspace'
    dsh_dir=$dsh_real_path
  fi
  dsh_join "$dsh_dir" "$3"; dsh_file=$dsh_joined
  if [ -d "$dsh_file" ]; then
    dsh_real "$dsh_file" || dsh_fail 403 'Not a readable directory'
    dsh_under "$dsh_root" "$dsh_real_path" || dsh_fail 403 'Path is outside the remote workspace'
  elif [ "$4" != 1 ] && [ ! -e "$dsh_file" ] && [ ! -L "$dsh_file" ]; then dsh_fail 404 'No such file or directory'
  fi
}
dsh_exists() { [ -e "$1" ] || [ -L "$1" ]; }
dsh_regular() { { [ -f "$1" ] && [ ! -L "$1" ]; } || dsh_fail 400 'Select a regular file'; }
dsh_size_of() { dsh_n=$(wc -c < "$1" 2>/dev/null) || return 1; dsh_n=$(($dsh_n)); }
dsh_hasher() {
  if command -v sha256sum >/dev/null 2>&1; then dsh_sha=sha256sum
  elif command -v shasum >/dev/null 2>&1; then dsh_sha='shasum -a 256'
  elif command -v openssl >/dev/null 2>&1; then dsh_sha='openssl dgst -sha256 -r'
  else dsh_fail 501 'The SSH host needs sha256sum, shasum or openssl to check file revisions'; fi
}
# SHA-256 of standard input.
dsh_digest() { set -- $($dsh_sha) && [ "\${#1}" -eq 64 ] && printf '%s' "$1"; }
dsh_check() {
  if dsh_exists "$1"; then
    dsh_regular "$1"
    dsh_size_of "$1" || dsh_fail 400 'Could not read the file'
    [ "$dsh_n" -le 52428800 ] || dsh_fail 413 'File exceeds the 50 MB transfer limit'
    dsh_current=$(dsh_digest < "$1") || dsh_fail 400 'Could not read the file'
  else dsh_current=; fi
  [ "$dsh_current" = "$2" ] || dsh_fail 409 'The file changed. Reload it before saving.'
}
# One line per file, in order: GNU, BusyBox and uutils take the first format, BSD the second. Nothing without stat.
dsh_stat() {
  dsh_gnu=$1 dsh_bsd=$2; shift 2
  if [ -z "$dsh_stat_kind" ]; then
    if stat -c %s . >/dev/null 2>&1; then dsh_stat_kind=gnu
    elif stat -f %z . >/dev/null 2>&1; then dsh_stat_kind=bsd
    else dsh_stat_kind=none; fi
  fi
  case $dsh_stat_kind in
    gnu) stat -c "$dsh_gnu" "$@" 2>/dev/null ;;
    bsd) stat -f "$dsh_bsd" "$@" 2>/dev/null ;;
  esac
}
# A file's exact permission bits as a symbolic chmod mode, from the POSIX \`ls -l\` format.
dsh_mode() {
  dsh_m=$(ls -ld "$1" 2>/dev/null) || return 1
  dsh_m=\${dsh_m%% *}
  case $dsh_m in ?[r-][w-][xsS-][r-][w-][xsS-][r-][w-][xtT-]*) ;; *) return 1 ;; esac
  printf '%s\\n' "$dsh_m" | sed -e 's/^.\\(...\\)\\(...\\)\\(...\\).*/u=\\1,g=\\2,o=\\3/' -e 's/[-ST]//g' -e 's/[st]/x/g'
}
dsh_temp() { dsh_t=$(mktemp -d "\${TMPDIR:-/tmp}/dsh-workspace.XXXXXXXXXX") || dsh_fail 500 'Could not create a temporary directory on the SSH host'; }
# Revision checks and the replacements they guard run under a per-file lock shared by every save on the host, so two
# saves holding the same revision cannot both succeed. Each contender announces itself with a uniquely named entry and
# proceeds only while no other live entry exists. Entries are never reused, so removing a dead holder's entry (for
# example one whose SSH session ended) can never remove a live one.
dsh_alive() {
  case $1 in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "$1" 2>/dev/null || return 1
  # An entry older than two minutes belongs to a holder whose process ID was reused.
  [ -z "$(find "$2" -prune -mmin +2 2>/dev/null)" ]
}
dsh_lock() {
  dsh_locks=$HOME/.dsh-remote-agents/locks
  (umask 077; mkdir -p "$dsh_locks") || dsh_fail 500 'Could not create the save lock directory'
  dsh_join "$1" "$2"
  dsh_key=$(printf '%s' "$dsh_joined" | dsh_digest) || dsh_fail 500 'Could not create a save lock'
  dsh_key=$dsh_key. dsh_end=$(($(date +%s) + 30)) dsh_attempt=0
  while :; do
    dsh_attempt=$((dsh_attempt + 1))
    # A fresh name per attempt: a removal aimed at an abandoned attempt must never hit a later one.
    dsh_mine=$dsh_locks/$dsh_key$$.$dsh_id.$dsh_attempt
    (set -C; : > "$dsh_mine") 2>/dev/null || { dsh_mine=; dsh_fail 500 'Could not create a save lock'; }
    dsh_contended=
    for dsh_other in "$dsh_locks/$dsh_key"*; do
      [ "$dsh_other" != "$dsh_mine" ] && [ -e "$dsh_other" ] || continue
      dsh_holder=\${dsh_other#"$dsh_locks/$dsh_key"}
      if dsh_alive "\${dsh_holder%%.*}" "$dsh_other"; then dsh_contended=1; else rm -f "$dsh_other"; fi
    done
    [ -n "$dsh_contended" ] || return 0
    rm -f "$dsh_mine"; dsh_mine=
    [ "$(date +%s)" -le "$dsh_end" ] || dsh_fail 409 'Another save to this file is still running. Try again.'
    # Contenders that saw each other all withdraw; randomized exponential backoff lets one of them through.
    dsh_cap=20 dsh_i=0
    while [ "$dsh_i" -lt "$dsh_attempt" ] && [ "$dsh_cap" -lt 1000 ]; do dsh_cap=$((dsh_cap * 2)) dsh_i=$((dsh_i + 1)); done
    [ "$dsh_cap" -le 1000 ] || dsh_cap=1000
    dsh_r=$(od -An -N2 -tu2 /dev/urandom 2>/dev/null) || dsh_r=
    sleep "$(printf '0.%03d' $(( \${dsh_r:-$$} % dsh_cap )))" 2>/dev/null || sleep 1
  done
}
dsh_unlock() { rm -f "$dsh_mine"; dsh_mine=; }
# Runs the shell code $2 in the background after $1 seconds unless stopped first; stopping it also ends its sleep.
dsh_after() {
  (
    trap 'kill "$dsh_sleep" 2>/dev/null; exit 0' 15
    sleep "$1" & dsh_sleep=$!
    wait "$dsh_sleep" && eval "$2"
  ) </dev/null >/dev/null 2>&1 &
}
# Walks the current directory without ignored names. Regular files up to $dsh_limit bytes go to dsh_files in batches
# and are recorded as "size path" lines in $dsh_t/kept; links, special and larger files are recorded as skipped.
# Paths containing a newline cannot be listed one per line, so they are skipped as well.
dsh_walk() {
  : > "$dsh_t/odd"; : > "$dsh_t/skipped"; : > "$dsh_t/kept"
  { find . \\( -name .git -o -name node_modules -o -name dist -o -name build -o -name target -o -name .dsh-remote-agents \\
      -o -name .dsh-remote-meta.json -o -name '.dsh-ra-upload-*' \\) -prune \\
      -o -name "*$dsh_nl*" -prune -exec sh -c 'for f do printf "%s\\0" "\${f#./}"; done >> "$0"' "$dsh_t/odd" {} + \\
      -o -print 2> "$dsh_t/find-error"
    printf '%s' "$?" > "$dsh_t/find-status"; } | head -n 20002 > "$dsh_t/paths"
  dsh_count=$(wc -l < "$dsh_t/paths")
  [ "$(($dsh_count))" -le 20001 ] || dsh_fail 400 'Workspace contains too many files for one operation'
  [ "$(cat "$dsh_t/find-status")" = 0 ] || dsh_fail 400 "$(tail -n 3 "$dsh_t/find-error")"
  dsh_total=0
  set --
  while IFS= read -r dsh_p; do
    if [ "$dsh_p" = . ] || { [ -d "$dsh_p" ] && [ ! -L "$dsh_p" ]; }; then continue
    elif [ -f "$dsh_p" ] && [ ! -L "$dsh_p" ]; then set -- "$@" "$dsh_p"; [ "$#" -lt 256 ] || { dsh_batch "$@"; set --; }
    else printf '%s\\0' "\${dsh_p#./}" >> "$dsh_t/skipped"; fi
  done < "$dsh_t/paths"
  [ "$#" -eq 0 ] || dsh_batch "$@"
  cat "$dsh_t/odd" >> "$dsh_t/skipped"
}
dsh_batch() {
  dsh_stat %s %z "$@" > "$dsh_t/sizes"
  # A file removed since the walk shifts stat's output; measure each file instead.
  dsh_lines=$(wc -l < "$dsh_t/sizes")
  [ "$(($dsh_lines))" -eq "$#" ] || : > "$dsh_t/sizes"
  exec 3< "$dsh_t/sizes"
  for dsh_f do
    shift
    IFS= read -r dsh_s <&3 || dsh_s=
    case $dsh_s in ''|*[!0-9]*) dsh_size_of "$dsh_f" || dsh_fail 409 'Files changed during the scan. Try again.'; dsh_s=$dsh_n ;; esac
    if [ "$dsh_s" -gt "$dsh_limit" ]; then printf '%s\\0' "\${dsh_f#./}" >> "$dsh_t/skipped"; continue; fi
    dsh_total=$((dsh_total + dsh_s))
    [ "$dsh_total" -le 536870912 ] || dsh_fail 400 'Workspace scan exceeds 512 MB'
    printf '%s %s\\n' "$dsh_s" "\${dsh_f#./}" >> "$dsh_t/kept"
    set -- "$@" "$dsh_f"
  done
  exec 3<&-
  [ "$#" -eq 0 ] || dsh_files "$@"
}

dsh_real "$dsh_cwd" || dsh_fail 404 'Not a readable directory'
dsh_root=$dsh_real_path
case $dsh_op in
list)
  dsh_resolve "$dsh_path" "$dsh_parent" "$dsh_base"
  [ -d "$dsh_file" ] || dsh_fail 400 'Not a directory'
  cd -P "$dsh_file" 2>/dev/null || dsh_fail 403 'Not a readable directory'
  set --
  for dsh_name in * .[!.]* ..?*; do
    dsh_exists "$dsh_name" || continue
    case $dsh_name in .dsh-remote-meta.json|.dsh-ra-upload-*) continue ;; esac
    set -- "$@" "./$dsh_name"
  done
  [ "$#" -le 10000 ] || dsh_fail 400 'Directory has too many entries'
  printf 'ok\\n'
  # NUL-terminated "<kind><name>" records, an empty record, then one "size mtime" line per entry.
  for dsh_name do
    if [ -L "$dsh_name" ]; then dsh_kind=l; elif [ -d "$dsh_name" ]; then dsh_kind=d; elif [ -f "$dsh_name" ]; then dsh_kind=f; else dsh_kind=o; fi
    printf '%s%s\\0' "$dsh_kind" "\${dsh_name#./}"
  done
  printf '\\0'
  [ "$#" -eq 0 ] || dsh_stat '%s %Y' '%z %m' "$@"
  ;;
read|download)
  dsh_resolve "$dsh_path" "$dsh_parent" "$dsh_base"
  dsh_regular "$dsh_file"
  dsh_size_of "$dsh_file" || dsh_fail 400 'Could not read the file'
  [ "$dsh_n" -le 52428800 ] || dsh_fail 413 'File exceeds the 50 MB transfer limit'
  [ "$dsh_op" = download ] || [ "$dsh_n" -le 262144 ] || dsh_fail 413 'File exceeds the 256 KB editor limit. Download it instead.'
  printf 'ok\\n'
  cat < "$dsh_file"
  ;;
stat)
  dsh_hasher
  dsh_resolve "$dsh_path" "$dsh_parent" "$dsh_base"
  dsh_regular "$dsh_file"
  dsh_size_of "$dsh_file" || dsh_fail 400 'Could not read the file'
  [ "$dsh_n" -le 52428800 ] || dsh_fail 413 'File exceeds the 50 MB transfer limit'
  dsh_current=$(dsh_digest < "$dsh_file") || dsh_fail 400 'Could not read the file'
  printf 'ok\\n%s %s\\n' "$dsh_current" "$dsh_n"
  ;;
upload)
  # Standard input is the file's new content, exactly $dsh_size bytes; $dsh_revision is empty for a new file.
  dsh_hasher
  dsh_resolve "$dsh_path" "$dsh_parent" "$dsh_base" 1
  dsh_check "$dsh_file" "$dsh_revision"
  dsh_join "$dsh_dir" ".dsh-ra-upload-$dsh_id"; dsh_tmp=$dsh_joined
  dsh_error=$( { umask 077; set -C; cat > "$dsh_tmp"; } 2>&1 ) || dsh_fail 400 "\${dsh_error:-Could not write the file}"
  dsh_size_of "$dsh_tmp" || dsh_fail 400 'Could not write the file'
  [ "$dsh_n" = "$dsh_size" ] || dsh_fail 400 'Upload byte count mismatch'
  dsh_new=$(dsh_digest < "$dsh_tmp") || dsh_fail 400 'Could not read the uploaded file'
  # A replaced file keeps its permissions, such as a script's execute bit.
  if [ -n "$dsh_revision" ]; then
    dsh_perm=$(dsh_mode "$dsh_file") && chmod "$dsh_perm" "$dsh_tmp" || dsh_fail 400 'Could not keep the file permissions'
  fi
  dsh_lock "$dsh_dir" "$dsh_base"
  dsh_check "$dsh_file" "$dsh_revision"
  if [ -z "$dsh_revision" ]; then
    # A link never replaces a file created meanwhile.
    if ! dsh_error=$(ln "$dsh_tmp" "$dsh_file" 2>&1); then
      dsh_exists "$dsh_file" && dsh_fail 409 'The file changed. Reload it before saving.'
      dsh_fail 400 "\${dsh_error:-Could not create the file}"
    fi
    rm -f "$dsh_tmp"
  else dsh_error=$(mv -f "$dsh_tmp" "$dsh_file" 2>&1) || dsh_fail 400 "\${dsh_error:-Could not replace the file}"; fi
  dsh_tmp=
  dsh_unlock
  printf 'ok\\n%s %s\\n' "$dsh_new" "$dsh_size"
  ;;
mkdir)
  dsh_resolve "$dsh_path" "$dsh_parent" "$dsh_base" 1
  dsh_exists "$dsh_file" && dsh_fail 409 'A file or folder with this name already exists'
  dsh_error=$(mkdir "$dsh_file" 2>&1) || { dsh_exists "$dsh_file" && dsh_fail 409 'A file or folder with this name already exists'; dsh_fail 400 "\${dsh_error:-Could not create the folder}"; }
  printf 'ok\\n'
  ;;
remove|move)
  dsh_hasher
  dsh_resolve "$dsh_path" "$dsh_parent" "$dsh_base"
  dsh_source=$dsh_file dsh_source_dir=$dsh_dir
  if [ "$dsh_op" = move ]; then dsh_resolve "$dsh_destination" "$dsh_destination_parent" "$dsh_destination_base" 1; fi
  dsh_lock "$dsh_source_dir" "$dsh_base"
  dsh_check "$dsh_source" "$dsh_revision"
  if [ "$dsh_op" = move ]; then
    # A link never overwrites an existing destination and keeps the file's inode.
    dsh_exists "$dsh_file" && dsh_fail 409 'A file or folder with this name already exists'
    if ! dsh_error=$(ln "$dsh_source" "$dsh_file" 2>&1); then
      dsh_exists "$dsh_file" && dsh_fail 409 'A file or folder with this name already exists'
      dsh_fail 400 "\${dsh_error:-Could not move the file}"
    fi
    dsh_check "$dsh_source" "$dsh_revision"
  fi
  dsh_error=$(rm -f "$dsh_source" 2>&1) || dsh_fail 400 "\${dsh_error:-Could not remove the file}"
  dsh_unlock
  printf 'ok\\n'
  ;;
manifest|search)
  [ "$dsh_op" = search ] || dsh_hasher
  dsh_resolve "$dsh_path" "$dsh_parent" "$dsh_base"
  [ -d "$dsh_file" ] || dsh_fail 400 'Not a directory'
  cd -P "$dsh_file" 2>/dev/null || dsh_fail 403 'Not a readable directory'
  dsh_temp
  : > "$dsh_t/digests"; : > "$dsh_t/matches"
  if [ "$dsh_op" = manifest ]; then
    dsh_limit=52428800
    dsh_files() { $dsh_sha "$@" >> "$dsh_t/digests" 2>/dev/null || dsh_fail 409 'Files changed during the scan. Try again.'; }
  else
    dsh_limit=262144 dsh_found=0
    # Text files only: grep lists candidates and a file containing a NUL byte is binary.
    dsh_files() {
      [ "$dsh_found" -lt 200 ] || return 0
      LC_ALL=C grep -l -F -e "$dsh_query" "$@" > "$dsh_t/hits" 2>/dev/null
      while [ "$dsh_found" -lt 200 ] && IFS= read -r dsh_f; do
        dsh_nul=$(tr -dc '\\000' < "$dsh_f" | wc -c)
        [ "$(($dsh_nul))" -eq 0 ] || continue
        LC_ALL=C grep -n -F -e "$dsh_query" "$dsh_f" 2>/dev/null | head -n "$((200 - dsh_found))" | cut -c 1-2000 > "$dsh_t/lines"
        dsh_lines=$(wc -l < "$dsh_t/lines")
        dsh_found=$((dsh_found + dsh_lines))
        { printf '%s\\n' "\${dsh_f#./}"; cat "$dsh_t/lines"; printf '\\0'; } >> "$dsh_t/matches"
      done < "$dsh_t/hits"
    }
  fi
  dsh_walk
  printf 'ok\\n'
  # manifest: "size path" lines, NUL, digest lines in the same order, NUL, then NUL-terminated skipped paths.
  # search: NUL-terminated "path\\n<line>:<text>..." records, an empty record, then NUL-terminated skipped paths.
  if [ "$dsh_op" = manifest ]; then cat "$dsh_t/kept"; printf '\\0'; cat "$dsh_t/digests"; printf '\\0'
  else cat "$dsh_t/matches"; printf '\\0'; fi
  cat "$dsh_t/skipped"
  ;;
command)
  dsh_resolve "$dsh_path" "$dsh_parent" "$dsh_base"
  [ -d "$dsh_file" ] || dsh_fail 400 'Not a directory'
  cd -P "$dsh_file" 2>/dev/null || dsh_fail 403 'Not a readable directory'
  dsh_temp
  mkfifo "$dsh_t/stdout" "$dsh_t/stderr" || dsh_fail 500 'Could not create the command output pipes'
  # Each stream is cut one byte past the output limit, so a flooding command stops on a closed pipe. The readers stay
  # outside the command's process group: stopping the command lets them finish writing what they read.
  head -c 262145 < "$dsh_t/stdout" > "$dsh_t/out" & dsh_readers=$!
  head -c 262145 < "$dsh_t/stderr" > "$dsh_t/err" & dsh_readers="$dsh_readers $!"
  dsh_run='/bin/sh -c "$1" </dev/null; printf %s "$?" > "$2/code"'
  # The command runs in its own process group so a timeout stops everything it started.
  if command -v setsid >/dev/null 2>&1; then
    setsid /bin/sh -c "$dsh_run" dsh-command "$dsh_command" "$dsh_t" </dev/null > "$dsh_t/stdout" 2> "$dsh_t/stderr" &
    dsh_job=$! dsh_group=1
  else
    set -m 2>/dev/null
    case $- in *m*) dsh_group=1 ;; esac
    /bin/sh -c "$dsh_run" dsh-command "$dsh_command" "$dsh_t" </dev/null > "$dsh_t/stdout" 2> "$dsh_t/stderr" &
    dsh_job=$!
    set +m 2>/dev/null
  fi
  if sleep 0.001 2>/dev/null; then dsh_seconds=$(printf '%d.%03d' $((dsh_timeout / 1000)) $((dsh_timeout % 1000)))
  else dsh_seconds=$(( (dsh_timeout + 999) / 1000 )); fi
  dsh_after "$dsh_seconds" ': > "$dsh_t/timed-out"; dsh_kill'; dsh_watch=$!
  wait "$dsh_job"
  kill "$dsh_watch" 2>/dev/null
  dsh_job=
  # A process the command moved out of its group may keep the output open; stop reading after a short grace period.
  dsh_after 2 'kill $dsh_readers'; dsh_grace=$!
  wait $dsh_readers
  kill "$dsh_grace" 2>/dev/null
  dsh_code=-; [ ! -s "$dsh_t/code" ] || dsh_code=$(cat "$dsh_t/code")
  dsh_timed_out=0; [ ! -e "$dsh_t/timed-out" ] || dsh_timed_out=1
  dsh_size_of "$dsh_t/out" || dsh_n=0; dsh_o=$dsh_n
  dsh_size_of "$dsh_t/err" || dsh_n=0; dsh_e=$dsh_n
  # "exit-code timed-out stdout-bytes stderr-bytes", then stdout and stderr.
  printf 'ok\\n%s %s %s %s\\n' "$dsh_code" "$dsh_timed_out" "$dsh_o" "$dsh_e"
  cat "$dsh_t/out" "$dsh_t/err" 2>/dev/null
  ;;
git)
  # The Git commands of one request, in order: dsh_count commands, the i-th with dsh_argc_<i> arguments dsh_arg_<i>_<j>
  # and a timeout of dsh_timeout_<i> milliseconds. Arguments go to Git as they are; no shell reads them. Each command
  # runs in its own process group, which a gitCancel request for dsh_id stops. With dsh_stop=1, a failure skips the rest.
  dsh_resolve "$dsh_path" "$dsh_parent" "$dsh_base"
  [ -d "$dsh_file" ] || dsh_fail 400 'Not a directory'
  cd -P "$dsh_file" 2>/dev/null || dsh_fail 403 'Not a readable directory'
  command -v git >/dev/null 2>&1 || dsh_fail 501 'Git is not installed on the SSH host'
  dsh_jobs=$HOME/.dsh-remote-agents/git
  (umask 077; mkdir -p "$dsh_jobs") || dsh_fail 500 'Could not create the Git job directory'
  dsh_temp
  mkfifo "$dsh_t/stdout" "$dsh_t/stderr" || dsh_fail 500 'Could not create the command output pipes'
  : > "$dsh_t/frames"
  # Git never waits for a password, an editor or a pager, and reports in English so its messages can be recognized.
  GIT_TERMINAL_PROMPT=0 GIT_ASKPASS= SSH_ASKPASS= GCM_INTERACTIVE=never GIT_EDITOR=: GIT_PAGER=cat PAGER=cat LC_ALL=C
  export GIT_TERMINAL_PROMPT GIT_ASKPASS SSH_ASKPASS GCM_INTERACTIVE GIT_EDITOR GIT_PAGER PAGER LC_ALL
  # Reads skip Git's optional index refresh, so they never hold the index lock another Git needs.
  [ "$dsh_optional_locks" = 1 ] || { GIT_OPTIONAL_LOCKS=0; export GIT_OPTIONAL_LOCKS; }
  dsh_run='dsh_c=$1; shift; "$@" </dev/null; printf %s "$?" > "$dsh_c"'
  if sleep 0.001 2>/dev/null; then dsh_fraction=1; else dsh_fraction=; fi
  dsh_i=0 dsh_failed=
  while [ "$dsh_i" -lt "$dsh_count" ]; do
    eval "dsh_argc=\\$dsh_argc_$dsh_i dsh_timeout=\\$dsh_timeout_$dsh_i"
    : > "$dsh_t/out"; : > "$dsh_t/err"; rm -f "$dsh_t/code" "$dsh_t/timed-out"
    if [ -n "$dsh_failed" ] || [ -e "$dsh_jobs/$dsh_id.cancel" ]; then dsh_code=skip
    else
      set -- git
      dsh_j=0
      while [ "$dsh_j" -lt "$dsh_argc" ]; do eval "set -- \\"\\$@\\" \\"\\$dsh_arg_\${dsh_i}_$dsh_j\\""; dsh_j=$((dsh_j + 1)); done
      # As for commands, each stream is cut one byte past its limit.
      head -c "$((dsh_limit + 1))" < "$dsh_t/stdout" > "$dsh_t/out" & dsh_readers=$!
      head -c 65537 < "$dsh_t/stderr" > "$dsh_t/err" & dsh_readers="$dsh_readers $!"
      dsh_group=
      if command -v setsid >/dev/null 2>&1; then
        setsid /bin/sh -c "$dsh_run" dsh-git "$dsh_t/code" "$@" </dev/null > "$dsh_t/stdout" 2> "$dsh_t/stderr" &
        dsh_job=$! dsh_group=1
      else
        set -m 2>/dev/null
        case $- in *m*) dsh_group=1 ;; esac
        /bin/sh -c "$dsh_run" dsh-git "$dsh_t/code" "$@" </dev/null > "$dsh_t/stdout" 2> "$dsh_t/stderr" &
        dsh_job=$!
        set +m 2>/dev/null
      fi
      dsh_tmp=$dsh_jobs/$dsh_id
      printf '%s\\n' "$dsh_job" > "$dsh_tmp"
      if [ -n "$dsh_fraction" ]; then dsh_seconds=$(printf '%d.%03d' $((dsh_timeout / 1000)) $((dsh_timeout % 1000)))
      else dsh_seconds=$(( (dsh_timeout + 999) / 1000 )); fi
      dsh_after "$dsh_seconds" ': > "$dsh_t/timed-out"; dsh_kill'; dsh_watch=$!
      wait "$dsh_job"
      kill "$dsh_watch" 2>/dev/null
      dsh_job=
      rm -f "$dsh_tmp"; dsh_tmp=
      dsh_after 2 'kill $dsh_readers'; dsh_grace=$!
      wait $dsh_readers
      kill "$dsh_grace" 2>/dev/null
      dsh_code=-; [ ! -s "$dsh_t/code" ] || dsh_code=$(cat "$dsh_t/code")
    fi
    dsh_timed_out=0; [ ! -e "$dsh_t/timed-out" ] || dsh_timed_out=1
    dsh_size_of "$dsh_t/out" || dsh_n=0; dsh_o=$dsh_n
    dsh_size_of "$dsh_t/err" || dsh_n=0; dsh_e=$dsh_n
    { printf '%s %s %s %s\\n' "$dsh_code" "$dsh_timed_out" "$dsh_o" "$dsh_e"; cat "$dsh_t/out" "$dsh_t/err"; } >> "$dsh_t/frames"
    [ "$dsh_code" = 0 ] || [ "$dsh_stop" != 1 ] || dsh_failed=1
    dsh_i=$((dsh_i + 1))
  done
  rm -f "$dsh_jobs/$dsh_id.cancel"
  # Per command: "exit-code timed-out stdout-bytes stderr-bytes", then stdout and stderr. The exit code is "skip" for a
  # command that did not run and "-" for one that was stopped.
  printf 'ok\\n'
  cat "$dsh_t/frames"
  ;;
gitCancel)
  # Stops the Git command the git request dsh_job_id is running, and the commands it has not started yet.
  case $dsh_job_id in ''|*[!0-9a-f-]*) dsh_fail 400 'Invalid Git request' ;; esac
  dsh_jobs=$HOME/.dsh-remote-agents/git
  if [ -d "$dsh_jobs" ]; then
    : > "$dsh_jobs/$dsh_job_id.cancel"
    # The marker of a request that had already finished is removed later.
    find "$dsh_jobs" -name '*.cancel' -mmin +10 -exec rm -f {} + 2>/dev/null
    dsh_p=$(cat "$dsh_jobs/$dsh_job_id" 2>/dev/null)
    case $dsh_p in ''|*[!0-9]*) ;; *) kill -s TERM -- "-$dsh_p" 2>/dev/null || kill -s TERM $(dsh_tree "$dsh_p") 2>/dev/null ;; esac
  fi
  printf 'ok\\n'
  ;;
*) dsh_fail 400 'Unknown workspace operation' ;;
esac
`;
