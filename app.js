// Bangalore Club Mahjong Log - App Logic (Cloud Database Sync & Current Week Filtering)

// --- Constants & Config ---
const MORNING_TIMES = [
  "10:00 AM", "10:30 AM", "11:00 AM", "11:30 AM", "12:00 PM", "12:30 PM", "1:00 PM"
];

const AFTERNOON_TIMES = [
  "2:00 PM", "2:30 PM", "3:00 PM", "3:30 PM", "4:00 PM", "4:30 PM", "5:00 PM", "5:30 PM", "6:00 PM"
];

// Unique database key on kvdb.io (shared free KV store)
const DB_URL = "https://kvdb.io/SvmeRCjC2rgQ5SvPj5n7y7/bookings";

// --- State ---
let state = {
  currentDay: "Monday",
  currentSlot: "Morning",
  bookings: []
};

// --- Helper: Date Range & Rolling Week Calculations ---
function getCurrentWeekDates() {
  const today = new Date();
  const currentDay = today.getDay(); // 0 = Sun, 1 = Mon, ..., 6 = Sat
  
  let diffToMonday = 0;
  if (currentDay === 0) {
    diffToMonday = 1; // Today is Sunday, Monday is tomorrow
  } else {
    diffToMonday = 1 - currentDay; // Monday is in the past or today
  }
  
  const monday = new Date(today);
  monday.setDate(today.getDate() + diffToMonday);
  
  const weekDates = {};
  const dayNames = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  
  for (let i = 0; i < 6; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const date = String(d.getDate()).padStart(2, "0");
    
    weekDates[dayNames[i]] = {
      dateString: `${year}-${month}-${date}`,
      label: d.toLocaleDateString("en-US", { month: "short", day: "numeric" })
    };
  }
  return weekDates;
}

// --- Load / Save Data via Cloud Database ---

async function fetchDatabaseBookings() {
  try {
    const response = await fetch(DB_URL);
    if (response.status === 404) {
      // Database is empty, initialize with seed data
      return await initializeSeedData();
    }
    if (!response.ok) throw new Error("Failed to fetch cloud database.");
    
    const data = await response.json();
    return Array.isArray(data) ? migrateData(data) : [];
  } catch (error) {
    console.warn("Database error, falling back to localStorage:", error);
    try {
      const saved = localStorage.getItem("mahjong_bookings");
      if (saved) {
        const parsed = JSON.parse(saved);
        return Array.isArray(parsed) ? migrateData(parsed) : [];
      }
    } catch (storageError) {
      console.error("Local storage read failed:", storageError);
    }
    return [];
  }
}

function migrateData(bookingsList) {
  if (!Array.isArray(bookingsList)) return [];
  try {
    const weekDates = getCurrentWeekDates();
    bookingsList.forEach(b => {
      if (!b) return;
      // 1. Convert string seat keys to numbers if needed
      if (b.seat === "N" || b.seat === "1") b.seat = 1;
      else if (b.seat === "E" || b.seat === "2") b.seat = 2;
      else if (b.seat === "S" || b.seat === "3") b.seat = 3;
      else if (b.seat === "W" || b.seat === "4") b.seat = 4;
      else b.seat = parseInt(b.seat) || 1;

      // 2. Inject current week date for old seed data lacking a date field
      if (!b.date) {
        b.date = weekDates[b.day]?.dateString || weekDates["Monday"].dateString;
      }
      if (!b.groupId) {
        b.groupId = `g-${Date.now()}-${Math.floor(Math.random()*1000)}`;
      }
    });
  } catch (e) {
    console.error("Migration error:", e);
  }
  return bookingsList;
}

async function saveDatabaseBookings(bookingsList) {
  try {
    const response = await fetch(DB_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(bookingsList)
    });
    if (!response.ok) throw new Error("Failed to write to cloud database.");
    localStorage.setItem("mahjong_bookings", JSON.stringify(bookingsList));
    return true;
  } catch (error) {
    console.error("Database save failed:", error);
    localStorage.setItem("mahjong_bookings", JSON.stringify(bookingsList));
    return false;
  }
}

async function initializeSeedData() {
  const weekDates = getCurrentWeekDates();
  const seed = [
    { id: "seed-1", date: weekDates["Monday"].dateString, day: "Monday", slot: "Morning", table: 1, seat: 1, name: "Alice Chen", timeStart: "10:00 AM", needSet: true, groupId: "g-seed-1" },
    { id: "seed-2", date: weekDates["Monday"].dateString, day: "Monday", slot: "Morning", table: 1, seat: 2, name: "Alice Chen (+1)", timeStart: "10:00 AM", needSet: true, groupId: "g-seed-1" },
    { id: "seed-3", date: weekDates["Monday"].dateString, day: "Monday", slot: "Morning", table: 3, seat: 1, name: "Sarah Connor", timeStart: "11:00 AM", needSet: false, groupId: "g-seed-2" },
    { id: "seed-4", date: weekDates["Monday"].dateString, day: "Monday", slot: "Afternoon", table: 5, seat: 1, name: "John Doe", timeStart: "2:30 PM", needSet: true, groupId: "g-seed-3" },
    { id: "seed-5", date: weekDates["Wednesday"].dateString, day: "Wednesday", slot: "Afternoon", table: 2, seat: 1, name: "David Kim", timeStart: "3:00 PM", needSet: false, groupId: "g-seed-4" }
  ];
  await saveDatabaseBookings(seed);
  return seed;
}

// Full page loader for initial sync
async function performInitialSync() {
  showLoading(true);
  try {
    state.bookings = await fetchDatabaseBookings();
  } catch (err) {
    console.error("Initial sync error:", err);
    state.bookings = [];
  } finally {
    showLoading(false);
    updateView();
  }
}

// Background sync (silent, no overlay)
async function performBackgroundSync() {
  const latestBookings = await fetchDatabaseBookings();
  if (JSON.stringify(latestBookings) !== JSON.stringify(state.bookings)) {
    state.bookings = latestBookings;
    updateView();
  }
}

// --- Initialize App ---
document.addEventListener("DOMContentLoaded", () => {
  setInitialDay();
  updateDayButtons();
  initEventListeners();
  
  // Load local cache first for instant layout rendering
  try {
    const saved = localStorage.getItem("mahjong_bookings");
    if (saved) {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        state.bookings = migrateData(parsed);
      }
    }
  } catch (err) {
    console.warn("Could not load local cache on startup:", err);
  }
  
  // Render layout immediately so there is no blank screen
  updateView();
  
  // Sync database bookings in background
  performInitialSync();
  
  // Set up 15-second background auto-refresh loop
  setInterval(performBackgroundSync, 15000);
});

// Update day buttons with date labels (e.g. Mon / Jun 1)
function updateDayButtons() {
  const weekDates = getCurrentWeekDates();
  document.querySelectorAll(".day-btn").forEach(btn => {
    const dayName = btn.getAttribute("data-day");
    const dateInfo = weekDates[dayName];
    if (dateInfo) {
      const shortName = dayName.substring(0, 3);
      btn.innerHTML = `<span class="day-label">${shortName}</span><span class="day-date">${dateInfo.label}</span>`;
    }
  });
}

// Set current day automatically based on system clock (Mon-Sat, else Monday)
function setInitialDay() {
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const currentDayName = days[new Date().getDay()];
  if (currentDayName !== "Sunday") {
    state.currentDay = currentDayName;
  } else {
    state.currentDay = "Monday"; // Sunday rolls over to Monday
  }
  
  // Set active class on active button
  document.querySelectorAll(".day-btn").forEach(btn => {
    if (btn.getAttribute("data-day") === state.currentDay) {
      btn.classList.add("active");
    } else {
      btn.classList.remove("active");
    }
  });
}

// --- View Updates / Rendering ---
function updateView() {
  const weekDates = getCurrentWeekDates();
  const activeDate = weekDates[state.currentDay];
  const dateLabel = activeDate ? activeDate.label : "";
  const slotLabel = state.currentSlot === "Morning" ? "Morning (10:00 AM - 1:00 PM)" : "Afternoon (2:00 PM - 6:00 PM)";
  
  document.getElementById("current-view-title").innerText = `${state.currentDay} (${dateLabel}) — ${slotLabel}`;
  
  renderRoomLayout();
  renderStatistics();
}

function renderStatistics() {
  const weekDates = getCurrentWeekDates();
  const activeDateString = weekDates[state.currentDay]?.dateString;
  
  // Filter only for the current selected date and slot
  const activeBookings = state.bookings.filter(
    b => b.date === activeDateString && b.slot === state.currentSlot
  );
  
  // Seats Filled
  const seatsFilled = activeBookings.length;
  document.getElementById("stat-seats-count").innerText = `${seatsFilled} / 36`;
  
  // Tables Occupied
  const occupiedTables = new Set(activeBookings.map(b => b.table));
  const tablesCount = occupiedTables.size;
  document.getElementById("stat-tables-count").innerText = `${tablesCount} / 9`;
  
  // Sets in Use
  const tablesNeedingSet = new Set(
    activeBookings.filter(b => b.needSet).map(b => b.table)
  );
  const setsCount = tablesNeedingSet.size;
  document.getElementById("stat-sets-count").innerText = `${setsCount} / 4`;
  
  // Warning check
  const setsWarning = document.getElementById("set-warning");
  if (setsCount > 4) {
    setsWarning.classList.add("show");
  } else {
    setsWarning.classList.remove("show");
  }
}

function renderRoomLayout() {
  const grid = document.getElementById("tables-grid");
  grid.innerHTML = "";
  
  const weekDates = getCurrentWeekDates();
  const activeDateString = weekDates[state.currentDay]?.dateString;
  
  // Filter bookings to only display the current calendar date and slot
  const activeBookings = state.bookings.filter(
    b => b.date === activeDateString && b.slot === state.currentSlot
  );
  
  for (let t = 1; t <= 9; t++) {
    const tableBookings = activeBookings.filter(b => b.table === t);
    
    // Create Table Card
    const tableCard = document.createElement("div");
    tableCard.className = "table-card";
    
    // Header
    const cardHeader = document.createElement("div");
    cardHeader.className = "table-card-header";
    
    const cardTitle = document.createElement("div");
    cardTitle.className = "table-card-title";
    cardTitle.innerHTML = `🀄 Table ${t}`;
    cardHeader.appendChild(cardTitle);
    
    const cardStatus = document.createElement("div");
    cardStatus.className = "table-card-status";
    cardStatus.innerText = `${tableBookings.length}/4`;
    cardHeader.appendChild(cardStatus);
    
    tableCard.appendChild(cardHeader);
    
    // Seat list container
    const seatList = document.createElement("div");
    seatList.className = "seat-list";
    
    // Render 4 seat rows
    for (let s = 1; s <= 4; s++) {
      const booking = tableBookings.find(b => b.seat === s);
      const seatRow = document.createElement("button");
      seatRow.className = "seat";
      
      const leftInfo = document.createElement("div");
      leftInfo.className = "seat-left-info";
      
      const badge = document.createElement("span");
      badge.className = "seat-number-badge";
      badge.innerText = s;
      leftInfo.appendChild(badge);
      
      if (booking) {
        seatRow.classList.add("occupied");
        
        const nameSpan = document.createElement("span");
        nameSpan.className = "seat-player-name";
        nameSpan.innerText = booking.name;
        leftInfo.appendChild(nameSpan);
        seatRow.appendChild(leftInfo);
        
        const timeSpan = document.createElement("span");
        timeSpan.className = "seat-player-time";
        timeSpan.innerText = booking.timeStart.split(" ")[0] + " " + booking.timeStart.split(" ")[1];
        seatRow.appendChild(timeSpan);
        
        seatRow.onclick = () => openDetailsModal(booking);
      } else {
        const emptySpan = document.createElement("span");
        emptySpan.className = "seat-player-name";
        emptySpan.style.color = "var(--color-text-muted)";
        emptySpan.innerText = "Empty Slot";
        leftInfo.appendChild(emptySpan);
        seatRow.appendChild(leftInfo);
        
        const claimSpan = document.createElement("span");
        claimSpan.className = "seat-action-text";
        claimSpan.innerText = "+ Book Seat";
        seatRow.appendChild(claimSpan);
        
        seatRow.onclick = () => openBookingModal(t, s);
      }
      
      seatList.appendChild(seatRow);
    }
    tableCard.appendChild(seatList);
    
    // Table footer space placeholder
    const cardFooter = document.createElement("div");
    cardFooter.className = "table-card-footer";
    tableCard.appendChild(cardFooter);
    
    grid.appendChild(tableCard);
  }
  lucide.createIcons();
}

// --- Modal Handlers ---

function populateTimeDropdown(timeList) {
  const startSelect = document.getElementById("player-time-start");
  startSelect.innerHTML = "";
  
  timeList.forEach(time => {
    const opt = document.createElement("option");
    opt.value = time;
    opt.innerText = time;
    startSelect.appendChild(opt);
  });
}

function openBookingModal(table, seat) {
  document.getElementById("player-name").value = "";
  document.getElementById("player-need-set").checked = false;
  
  document.getElementById("modal-table-id").value = table;
  document.getElementById("modal-seat-id").value = seat;
  document.getElementById("modal-title").innerText = `Book Table ${table} — Slot ${seat}`;
  
  const weekDates = getCurrentWeekDates();
  const activeDateString = weekDates[state.currentDay]?.dateString;
  
  // Cap guest bookings based on table space (fresh check)
  const activeBookings = state.bookings.filter(
    b => b.date === activeDateString && b.slot === state.currentSlot && b.table === table
  );
  const occupiedSeats = activeBookings.map(b => b.seat);
  const freeSeatCount = 4 - occupiedSeats.length;
  
  const guestSelect = document.getElementById("player-guests");
  guestSelect.innerHTML = "";
  
  const opt0 = document.createElement("option");
  opt0.value = 0;
  opt0.innerText = "Just me (1 seat)";
  guestSelect.appendChild(opt0);
  
  for (let g = 1; g < freeSeatCount; g++) {
    const opt = document.createElement("option");
    opt.value = g;
    opt.innerText = `+ ${g} ${g === 1 ? 'guest' : 'guests'} (${g + 1} seats)`;
    guestSelect.appendChild(opt);
  }
  
  const timeList = state.currentSlot === "Morning" ? MORNING_TIMES : AFTERNOON_TIMES;
  populateTimeDropdown(timeList);
  
  document.getElementById("booking-modal").classList.remove("hidden");
}

function closeBookingModal() {
  document.getElementById("booking-modal").classList.add("hidden");
}

let selectedBookingForDetails = null;

function openDetailsModal(booking) {
  selectedBookingForDetails = booking;
  
  document.getElementById("detail-location").innerText = `Table ${booking.table} — Slot ${booking.seat}`;
  
  const groupBookings = state.bookings.filter(b => b.groupId === booking.groupId);
  if (groupBookings.length > 1) {
    const primaryBooking = groupBookings.find(b => !b.name.includes("(+")) || groupBookings[0];
    document.getElementById("detail-name").innerText = `${booking.name} (Part of ${primaryBooking.name}'s group of ${groupBookings.length})`;
  } else {
    document.getElementById("detail-name").innerText = booking.name;
  }
  
  document.getElementById("detail-time").innerText = booking.timeStart;
  document.getElementById("detail-set").innerText = booking.needSet ? "Yes, requested Club Set" : "No (Bringing own set)";
  document.getElementById("detail-set").style.color = booking.needSet ? "var(--color-gold)" : "var(--color-text-muted)";
  
  const cancelConfirm = document.getElementById("cancel-confirm-area");
  
  if (groupBookings.length > 1) {
    const primaryName = groupBookings.find(b => !b.name.includes("(+"))?.name || groupBookings[0].name;
    cancelConfirm.innerHTML = `
      <p class="warning-text"><strong>Group Booking Warning:</strong> Cancelling this will cancel ALL ${groupBookings.length} seats reserved under this group.</p>
      <p class="warning-text">To cancel the group, please confirm the booking name <strong>"${primaryName}"</strong> below:</p>
      <div class="form-group">
        <input type="text" id="cancel-name-input" placeholder="Type group booking name to cancel">
      </div>
      <p class="error-text hidden" id="cancel-error">Name does not match the booking!</p>
    `;
  } else {
    cancelConfirm.innerHTML = `
      <p class="warning-text">To cancel, please confirm your booking name below:</p>
      <div class="form-group">
        <input type="text" id="cancel-name-input" placeholder="Type your name to cancel">
      </div>
      <p class="error-text hidden" id="cancel-error">Name does not match the booking!</p>
    `;
  }
  
  document.getElementById("details-modal").classList.remove("hidden");
}

function closeDetailsModal() {
  document.getElementById("details-modal").classList.add("hidden");
  selectedBookingForDetails = null;
}

// --- Event Listeners and Button Logic ---
function initEventListeners() {
  // Day selectors
  document.getElementById("day-selector").addEventListener("click", (e) => {
    const btn = e.target.closest(".day-btn");
    if (btn) {
      document.querySelectorAll(".day-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.currentDay = btn.getAttribute("data-day");
      updateView();
    }
  });

  // Slot selectors
  document.getElementById("slot-selector").addEventListener("click", (e) => {
    const btn = e.target.closest(".slot-btn");
    if (btn) {
      document.querySelectorAll(".slot-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      state.currentSlot = btn.getAttribute("data-slot");
      updateView();
    }
  });

  // Modals closure
  document.getElementById("btn-close-booking-modal").addEventListener("click", closeBookingModal);
  document.getElementById("btn-cancel-booking-form").addEventListener("click", closeBookingModal);
  
  document.getElementById("btn-close-details-modal").addEventListener("click", closeDetailsModal);
  document.getElementById("btn-close-details").addEventListener("click", closeDetailsModal);

  // Forms
  document.getElementById("booking-form").addEventListener("submit", (e) => {
    e.preventDefault();
    handleNewBooking();
  });

  document.getElementById("btn-cancel-booking").addEventListener("click", () => {
    handleCancelBooking();
  });

  // Backup Sync listeners
  const btnExport = document.getElementById("btn-export-data");
  if (btnExport) btnExport.addEventListener("click", openExportModal);
  const btnImport = document.getElementById("btn-import-data");
  if (btnImport) btnImport.addEventListener("click", openImportModal);
}

// --- Action Logic & Concurrency Checking ---

async function handleNewBooking() {
  const table = parseInt(document.getElementById("modal-table-id").value);
  const seat = parseInt(document.getElementById("modal-seat-id").value);
  const name = document.getElementById("player-name").value.trim();
  const guestCount = parseInt(document.getElementById("player-guests").value);
  const timeStart = document.getElementById("player-time-start").value;
  const needSet = document.getElementById("player-need-set").checked;
  
  if (!name) {
    showToast("Please enter a name.", "error");
    return;
  }

  showLoading(true);

  // Fetch the latest fresh state from the cloud database to check concurrency
  let freshBookings;
  try {
    freshBookings = await fetchDatabaseBookings();
  } catch (err) {
    showLoading(false);
    showToast("Database synchronization failed. Please try again.", "error");
    return;
  }

  const weekDates = getCurrentWeekDates();
  const activeDateString = weekDates[state.currentDay]?.dateString;

  // Check if target seat is already taken in the fresh cloud data for this specific date
  const activeBookings = freshBookings.filter(
    b => b.date === activeDateString && b.slot === state.currentSlot && b.table === table
  );
  
  const occupiedSeats = activeBookings.map(b => b.seat);
  
  if (occupiedSeats.includes(seat)) {
    showLoading(false);
    closeBookingModal();
    state.bookings = freshBookings;
    updateView();
    showToast("This seat was just booked by another member! Please select an empty slot.", "error");
    return;
  }

  // Find remaining free seats at the table in fresh data
  const freeSeats = [];
  for (let s = 1; s <= 4; s++) {
    if (!occupiedSeats.includes(s)) {
      freeSeats.push(s);
    }
  }

  // Ensure there are enough remaining free seats to fit the group
  const requiredSeats = 1 + guestCount;
  if (freeSeats.length < requiredSeats) {
    showLoading(false);
    closeBookingModal();
    state.bookings = freshBookings;
    updateView();
    showToast(`Someone just claimed seats. There are no longer ${requiredSeats} empty slots at Table ${table}!`, "error");
    return;
  }

  // Create group bookings
  const groupId = `g-${Date.now()}-${Math.floor(Math.random()*1000)}`;
  const newGroupBookings = [];

  // 1. Primary booking
  newGroupBookings.push({
    id: `book-${Date.now()}-primary`,
    date: activeDateString,
    day: state.currentDay,
    slot: state.currentSlot,
    table,
    seat,
    name,
    timeStart,
    needSet,
    groupId
  });

  // 2. Guest bookings
  let seatsBooked = [seat];
  let guestsRemaining = guestCount;
  for (let sIndex = 0; sIndex < freeSeats.length && guestsRemaining > 0; sIndex++) {
    const currentFree = freeSeats[sIndex];
    if (currentFree !== seat) {
      newGroupBookings.push({
        id: `book-${Date.now()}-guest-${guestsRemaining}`,
        date: activeDateString,
        day: state.currentDay,
        slot: state.currentSlot,
        table,
        seat: currentFree,
        name: `${name} (+${guestCount - guestsRemaining + 1})`,
        timeStart,
        needSet,
        groupId
      });
      seatsBooked.push(currentFree);
      guestsRemaining--;
    }
  }

  // Concat and write back to database
  const updatedBookings = freshBookings.concat(newGroupBookings);
  const success = await saveDatabaseBookings(updatedBookings);

  showLoading(false);
  closeBookingModal();

  if (success) {
    state.bookings = updatedBookings;
    updateView();
    if (guestCount > 0) {
      showToast(`Booked ${guestCount + 1} seats at Table ${table} for ${name} and guests!`);
    } else {
      showToast(`Successfully booked Table ${table} seat slot for ${name}!`);
    }
  } else {
    showToast("Failed to save booking. Please check your connection.", "error");
  }
}

async function handleCancelBooking() {
  if (!selectedBookingForDetails) return;
  
  const id = selectedBookingForDetails.id;
  const originalName = selectedBookingForDetails.name;
  const groupId = selectedBookingForDetails.groupId;
  
  const groupBookings = state.bookings.filter(b => b.groupId === groupId);
  const primaryBooking = groupBookings.find(b => !b.name.includes("(+")) || groupBookings[0];
  const primaryName = primaryBooking.name;
  
  const cancelInput = document.getElementById("cancel-name-input");
  const nameConfirm = cancelInput.value.trim();
  
  if (nameConfirm.toLowerCase() === originalName.toLowerCase() || 
      nameConfirm.toLowerCase() === primaryName.toLowerCase()) {
    
    showLoading(true);

    let freshBookings;
    try {
      freshBookings = await fetchDatabaseBookings();
    } catch (err) {
      showLoading(false);
      showToast("Sync failed. Check connection.", "error");
      return;
    }

    const updatedBookings = freshBookings.filter(b => b.groupId !== groupId);
    const success = await saveDatabaseBookings(updatedBookings);

    showLoading(false);
    closeDetailsModal();

    if (success) {
      state.bookings = updatedBookings;
      updateView();
      if (groupBookings.length > 1) {
        showToast(`Cancelled all ${groupBookings.length} bookings under group "${primaryName}".`, "warning");
      } else {
        showToast(`Cancelled booking for ${originalName}.`);
      }
    } else {
      showToast("Failed to sync cancellation.", "error");
    }
  } else {
    const errorText = document.getElementById("cancel-error");
    errorText.classList.remove("hidden");
    cancelInput.focus();
  }
}

// --- Backup Modal Operations ---
function openExportModal() {
  const modal = document.getElementById("export-modal");
  const textarea = document.getElementById("export-text");
  textarea.value = JSON.stringify(state.bookings, null, 2);
  modal.classList.remove("hidden");
}

function copyExportData() {
  const textarea = document.getElementById("export-text");
  textarea.select();
  try {
    document.execCommand("copy");
    showToast("Data copied to clipboard!");
  } catch (err) {
    showToast("Failed to copy data.", "error");
  }
}

function openImportModal() {
  const modal = document.getElementById("import-modal");
  const textarea = document.getElementById("import-text");
  const errorText = document.getElementById("import-error");
  
  textarea.value = "";
  errorText.classList.add("hidden");
  modal.classList.remove("hidden");
}

async function handleImportData() {
  const text = document.getElementById("import-text").value.trim();
  const errorText = document.getElementById("import-error");
  
  if (!text) {
    errorText.innerText = "Please paste some data.";
    errorText.classList.remove("hidden");
    return;
  }
  
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) {
      throw new Error("Data must be an array of bookings");
    }
    
    parsed.forEach(b => {
      if (b.seat === "N" || b.seat === "1") b.seat = 1;
      else if (b.seat === "E" || b.seat === "2") b.seat = 2;
      else if (b.seat === "S" || b.seat === "3") b.seat = 3;
      else if (b.seat === "W" || b.seat === "4") b.seat = 4;
      else b.seat = parseInt(b.seat);
      
      if (!b.groupId) {
        b.groupId = `g-${Date.now()}-${Math.floor(Math.random()*1000)}`;
      }
    });

    showLoading(true);
    const success = await saveDatabaseBookings(parsed);
    showLoading(false);

    if (success) {
      state.bookings = parsed;
      document.getElementById("import-modal").classList.add("hidden");
      updateView();
      showToast("Successfully imported scheduling data!");
    } else {
      throw new Error("Cloud save failure during import.");
    }
  } catch (err) {
    errorText.innerText = `Import failed: ${err.message}`;
    errorText.classList.remove("hidden");
  }
}

// --- Loading Overlay Controller ---
function showLoading(isVisible) {
  const overlay = document.getElementById("loading-overlay");
  if (isVisible) {
    overlay.classList.remove("hidden");
  } else {
    overlay.classList.add("hidden");
  }
}

// --- Toast System ---
function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  
  let iconName = "check-circle";
  if (type === "error") iconName = "x-circle";
  if (type === "warning") iconName = "alert-triangle";
  
  toast.innerHTML = `<i data-lucide="${iconName}"></i> <span>${message}</span>`;
  
  container.appendChild(toast);
  lucide.createIcons();
  
  setTimeout(() => {
    toast.remove();
  }, 5000);
}

