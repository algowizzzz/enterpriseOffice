# Getting started on Windows

Everything DocForge needs is already inside this folder. You do not need
administrator rights, you do not need to install anything, and your computer
does not need to be connected to the internet.

## Starting it

1. Find the file called **start-docforge.cmd** in this folder.
2. Double-click it. A black window will appear briefly, and your web browser
   will open to the sign-in page. The first time, this can take a few
   seconds.
3. Leave the black window open while you work; it is what keeps DocForge
   running. Closing it stops DocForge. You can minimise it.

If your browser does not open on its own, open it yourself and go to:

    http://127.0.0.1:8080

## Signing in the very first time

The first time you start DocForge on this computer, there is no account yet.

1. Close the black window if it opened.
2. Right-click **start-docforge.cmd**, choose **Edit**, and find the line
   that begins `if "%DOCFORGE_ADMIN_PASSWORD%"==""`. Just above it, add a
   line that sets a password, for example:

       set "DOCFORGE_ADMIN_PASSWORD=Choose-A-Strong-One-1"

   Choose your own password: twelve characters or more, with a mix of
   upper case, lower case and at least one number.
3. Save the file and double-click it again to start DocForge.
4. Sign in at the page that opens, using the email address
   `admin@localhost` and the password you just chose.
5. Once you are signed in, open the file for editing again, remove the line
   you added, and save it. The password is only needed for that first
   account; leaving it in the file after that is not necessary.

## Where your documents are kept

Everything you upload and every document you create is stored only on this
computer, in a single file:

    %LOCALAPPDATA%\DocForge\docforge.db

Nothing is sent anywhere else. If your IT department backs up this computer,
ask them to include that folder. To start over completely, close DocForge
and delete that file; the next time you start it, it will ask you to create
the first account again.

## Everyday use

- Bookmark `http://127.0.0.1:8080` in your browser so you can get back to it
  without hunting for the folder.
- You can create as many accounts as you like once you are signed in, from
  the Administration page, for other people who use this same computer.
- To close DocForge for the day, just close the black window. To use it
  again, double-click **start-docforge.cmd** as before; your documents are
  still there.

## If something goes wrong

- **The black window closes immediately and nothing opens.** Something else
  on this computer is already using the address `127.0.0.1:8080`. Ask your
  IT department for help, or edit `start-docforge.cmd` and change
  `DOCFORGE_PORT=8080` to a different number such as `8090`, then open
  `http://127.0.0.1:8090` instead.
- **Your browser says it cannot connect.** Wait a few more seconds after
  double-clicking; the first start of the day takes a little longer.
- **You want to hand this to your IT department first.** Everything they
  need to check it over is in this same folder: `THIRD-PARTY-NOTICES.txt`
  lists every piece of software inside it and its licence, `sbom.cdx.json`
  is the same list in the format a security scanner reads, and
  `SHA256SUMS` lets them confirm nothing in this folder was altered after
  it was built.
