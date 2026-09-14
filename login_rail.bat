@echo off
set RAILWAY_EXE=C:\Users\MyBook Pro L\AppData\Roaming\npm\railway.cmd
"%RAILWAY_EXE%" login --browserless > "%TEMP%\rail_login.out" 2> "%TEMP%\rail_login.err"