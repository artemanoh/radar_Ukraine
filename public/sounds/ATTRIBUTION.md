# Аудіо ресурси та ліцензії (Audio Assets Attribution)

Усі звукові файли, що використовуються в системі «РАДАР», є легальними, вільними для використання та мають ліцензію Public Domain або Creative Commons Zero (CC0).

---

### 1. `siren.ogg` (Сигнал тривоги / повітряна небезпека)
* **Призначення**: Звуковий сигнал при переході території в стан активної тривоги (офіційний alert level RED/CRITICAL).
* **Тривалість**: 10 секунд
* **Джерело**: [Wikimedia Commons - File:Alarm or siren.ogg](https://commons.wikimedia.org/wiki/File:Alarm_or_siren.ogg)
* **Оригінальний репозиторій**: PDSounds.org (Record #313)
* **Автор / Artist**: stephan
* **Ліцензія**: **Public Domain (Суспільне надбання)**
* **Умови використання**: Free for any use, no attribution required.

---

### 2. `chime.ogg` (Інформаційний сигнал / загроза)
* **Призначення**: Звуковий сигнал короткого сповіщення про нову загрозу або важливе повідомлення щодо відстежуваної території.
* **Тривалість**: 0.2 секунди (3520 Hz чистий тон)
* **Джерело**: [Wikimedia Commons - File:Short Beep.ogg](https://commons.wikimedia.org/wiki/File:Short_Beep.ogg)
* **Автор / Artist**: YJJcoolcool
* **Ліцензія**: **Creative Commons Zero 1.0 (CC0 1.0 Public Domain Dedication)**
* **Посилання на ліцензію**: https://creativecommons.org/publicdomain/zero/1.0/
* **Умови використання**: Free for any use, dedication to public domain worldwide.

---

### 3. Web Audio API Синтезатор (Резервний генератор звуку)
* **Призначення**: Fallback-генерація звуку сирени та подвійного тону (Chime) через стандартний браузерний інтерфейс `AudioContext` у випадках блокування медіафайлів політикою браузера (Autoplay Policy) або відсутності інтернет-доступу до локальних аудіофайлів.
* **Ліцензія**: Власна реалізація (MIT / Open Source).
