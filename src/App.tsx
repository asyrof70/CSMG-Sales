import React, { useState, useMemo, useEffect, useRef } from 'react';
import { Pelanggan, PipelineFeature, FilterState, SupabaseConfig } from './types';
import { INITIAL_PELANGGAN, INITIAL_PIPELINES, SALES_LIST, ZONA_LIST } from './data/mockData';
import { Navbar } from './components/Navbar';
import { FilterBar } from './components/FilterBar';
import { MapView } from './components/MapView';
import { AnalyticsPanel } from './components/AnalyticsPanel';
import { UploadModal } from './components/UploadModal';
import { AddPelangganModal } from './components/AddPelangganModal';
import { GuideModal } from './components/GuideModal';
import { SupabaseModal } from './components/SupabaseModal';
import { GoogleSheetsSyncModal } from './components/GoogleSheetsSyncModal';
import { fetchGoogleSheetLive, normalizeSpreadsheetRows } from './utils/excelParser';
import { createClient } from '@supabase/supabase-js';
import {
  Maximize2,
  Minimize2,
  Layers,
  Map as MapIcon,
  BarChart2,
  CheckCircle,
  Plus
} from 'lucide-react';

export default function App() {
  const [pelangganList, setPelangganList] = useState<Pelanggan[]>(() => {
    const saved = localStorage.getItem('aetra_pelanggan_data');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return INITIAL_PELANGGAN;
      }
    }
    return INITIAL_PELANGGAN;
  });

  const [pipelineList, setPipelineList] = useState<PipelineFeature[]>(() => {
    const saved = localStorage.getItem('aetra_pipeline_data');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return INITIAL_PIPELINES;
      }
    }
    return INITIAL_PIPELINES;
  });

  const [selectedPelanggan, setSelectedPelanggan] = useState<Pelanggan | null>(null);

  // Filters state
  const [filter, setFilter] = useState<FilterState>({
    zona: 'all',
    sales: 'all',
    status: 'all',
    search: '',
    startDate: '',
    endDate: '',
  });

  // Modals state
  const [isUploadOpen, setIsUploadOpen] = useState(false);
  const [isAddOpen, setIsAddOpen] = useState(false);
  const [isGuideOpen, setIsGuideOpen] = useState(false);
  const [isSupabaseOpen, setIsSupabaseOpen] = useState(false);
  const [isSheetsSyncOpen, setIsSheetsSyncOpen] = useState(false);

  // Google Sheets Auto-Sync state
  const [savedSheetUrl, setSavedSheetUrl] = useState<string>(() => {
    return localStorage.getItem('aetra_sheets_url') || '';
  });
  const [autoSyncActive, setAutoSyncActive] = useState<boolean>(false);
  const [syncIntervalSeconds, setSyncIntervalSeconds] = useState<number>(30);

  // Map click coordinate for add mode
  const [addCoordinates, setAddCoordinates] = useState<{ lat?: number; lng?: number }>({});

  // Supabase Configuration
  const [supabaseConfig, setSupabaseConfig] = useState<SupabaseConfig>(() => {
    const saved = localStorage.getItem('aetra_supabase_config');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch {
        return { url: '', anonKey: '', isConnected: false };
      }
    }
    return { url: '', anonKey: '', isConnected: false };
  });

  // Toast notification
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 3500);
  };

  // Sync to local storage
  useEffect(() => {
    localStorage.setItem('aetra_pelanggan_data', JSON.stringify(pelangganList));
  }, [pelangganList]);

  useEffect(() => {
    localStorage.setItem('aetra_pipeline_data', JSON.stringify(pipelineList));
  }, [pipelineList]);

  // Google Sheets Auto Polling in Background if enabled
  useEffect(() => {
    if (!autoSyncActive || !savedSheetUrl) return;

    const interval = setInterval(async () => {
      try {
        const rows = await fetchGoogleSheetLive(savedSheetUrl);
        if (rows && rows.length > 0) {
          const { pelanggan } = normalizeSpreadsheetRows(rows, pipelineList);
          if (pelanggan.length > 0) {
            setPelangganList((prev) => {
              const prevNames = new Set(prev.map((p) => `${p.nama}-${p.latitude}-${p.longitude}`));
              const newItems = pelanggan.filter(
                (p) => !prevNames.has(`${p.nama}-${p.latitude}-${p.longitude}`)
              );
              if (newItems.length > 0) {
                showToast(`⚡ ${newItems.length} data baru otomatis masuk dari AppSheet!`);
                return [...newItems, ...prev];
              }
              return prev;
            });
          }
        }
      } catch (e) {
        console.error('Background sync failed:', e);
      }
    }, syncIntervalSeconds * 1000);

    return () => clearInterval(interval);
  }, [autoSyncActive, savedSheetUrl, syncIntervalSeconds, pipelineList]);

  // Live Supabase Sync if configured
  useEffect(() => {
    if (!supabaseConfig.url || !supabaseConfig.anonKey || !supabaseConfig.isConnected) return;

    try {
      const client = createClient(supabaseConfig.url, supabaseConfig.anonKey);

      // Fetch latest records
      client
        .from('pelanggan')
        .select('*')
        .order('created_at', { ascending: false })
        .then(({ data, error }) => {
          if (data && data.length > 0) {
            setPelangganList((prev) => {
              const merged = [...data, ...prev.filter((p) => !data.some((d: any) => d.id === p.id))];
              return merged;
            });
            showToast(`Berhasil menyinkronkan ${data.length} data pelanggan dari Supabase`);
          }
        });

      // Subscribe to Realtime inserts from Google Sheets / AppSheet Webhook!
      const channel = client
        .channel('public:pelanggan')
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'pelanggan' },
          (payload) => {
            const newRecord = payload.new as Pelanggan;
            setPelangganList((prev) => [newRecord, ...prev]);
            showToast(`Data baru diterima dari AppSheet: ${newRecord.nama} (${newRecord.status_minat})`);
          }
        )
        .subscribe();

      return () => {
        client.removeChannel(channel);
      };
    } catch (err) {
      console.error('Supabase real-time sync error:', err);
    }
  }, [supabaseConfig]);

  // Filtered customer list calculation
  const filteredPelanggan = useMemo(() => {
    return pelangganList.filter((item) => {
      // Zona filter
      if (filter.zona !== 'all' && item.zona_id !== filter.zona) return false;

      // Sales filter
      if (filter.sales !== 'all' && item.sales_id !== filter.sales) return false;

      // Status minat filter
      if (filter.status !== 'all' && item.status_minat !== filter.status) return false;

      // Date range filter
      if (filter.startDate && item.tanggal_spreading < filter.startDate) return false;
      if (filter.endDate && item.tanggal_spreading > filter.endDate) return false;

      // Text search
      if (filter.search.trim()) {
        const query = filter.search.toLowerCase();
        const matchNama = item.nama.toLowerCase().includes(query);
        const matchAlamat = item.alamat.toLowerCase().includes(query);
        const matchSales = item.sales_nama.toLowerCase().includes(query);
        const matchTelepon = (item.telepon || '').includes(query);
        const matchKet = (item.keterangan || '').toLowerCase().includes(query);

        if (!matchNama && !matchAlamat && !matchSales && !matchTelepon && !matchKet) {
          return false;
        }
      }

      return true;
    });
  }, [pelangganList, filter]);

  // Handlers
  const handleFilterChange = (newFilter: Partial<FilterState>) => {
    setFilter((prev) => ({ ...prev, ...newFilter }));
  };

  const handleResetFilter = () => {
    setFilter({
      zona: 'all',
      sales: 'all',
      status: 'all',
      search: '',
      startDate: '',
      endDate: '',
    });
  };

  const handleAddPelanggan = (newPelanggan: Pelanggan) => {
    setPelangganList((prev) => [newPelanggan, ...prev]);
    setSelectedPelanggan(newPelanggan);
    showToast(`Pelanggan baru "${newPelanggan.nama}" berhasil disimpan`);

    // If Supabase is connected, insert to remote database
    if (supabaseConfig.isConnected && supabaseConfig.url && supabaseConfig.anonKey) {
      try {
        const client = createClient(supabaseConfig.url, supabaseConfig.anonKey);
        client
          .from('pelanggan')
          .insert([
            {
              nama: newPelanggan.nama,
              alamat: newPelanggan.alamat,
              telepon: newPelanggan.telepon,
              latitude: newPelanggan.latitude,
              longitude: newPelanggan.longitude,
              status_minat: newPelanggan.status_minat,
              sales_nama: newPelanggan.sales_nama,
              zona_nama: newPelanggan.zona_nama,
              tanggal_spreading: newPelanggan.tanggal_spreading,
              keterangan: newPelanggan.keterangan,
              jarak_pipa_meter: newPelanggan.jarak_pipa_meter,
            },
          ])
          .then(({ error }) => {
            if (error) {
              console.error('Supabase insert error:', error);
            }
          });
      } catch (e) {
        console.error('Failed to sync to Supabase:', e);
      }
    }
  };

  const handleDataLoadedFromSheets = (incoming: Pelanggan[], message: string) => {
    setPelangganList((prev) => {
      // Merge by unique ID / coordinates
      const existingMap = new Map(prev.map((p) => [p.id, p]));
      incoming.forEach((item) => {
        existingMap.set(item.id, item);
      });
      return Array.from(existingMap.values());
    });
    showToast(message);
  };

  const handleAddPipeline = (newPipe: PipelineFeature) => {
    setPipelineList((prev) => [newPipe, ...prev]);
    showToast(`Layer pipa "${newPipe.nama}" berhasil ditambahkan ke peta satelit`);
  };

  const handleMapClickAdd = (lat: number, lng: number) => {
    setAddCoordinates({ lat, lng });
    setIsAddOpen(true);
  };

  return (
    <div className="flex flex-col h-screen w-screen bg-slate-950 text-slate-100 overflow-hidden font-sans">
      {/* Top Navbar */}
      <Navbar
        onOpenUpload={() => setIsUploadOpen(true)}
        onOpenAddPelanggan={() => {
          setAddCoordinates({});
          setIsAddOpen(true);
        }}
        onOpenGuide={() => setIsGuideOpen(true)}
        onOpenSupabase={() => setIsSupabaseOpen(true)}
        onOpenSheetsSync={() => setIsSheetsSyncOpen(true)}
        autoSyncActive={autoSyncActive}
        supabaseConfig={supabaseConfig}
        totalPelanggan={pelangganList.length}
      />

      {/* Filter Toolbar */}
      <FilterBar
        filter={filter}
        onFilterChange={handleFilterChange}
        onResetFilter={handleResetFilter}
        zonas={ZONA_LIST}
        salesList={SALES_LIST}
        totalFiltered={filteredPelanggan.length}
        totalAll={pelangganList.length}
      />

      {/* Main Content: Split Map & Analytics */}
      <div className="flex-1 flex flex-col lg:flex-row overflow-hidden relative">
        {/* Left Side: Leaflet Satellite Map */}
        <div className="flex-1 relative h-full">
          <MapView
            pelangganList={filteredPelanggan}
            pipelineList={pipelineList}
            zonasList={ZONA_LIST}
            selectedPelanggan={selectedPelanggan}
            onSelectPelanggan={setSelectedPelanggan}
            onMapClickAdd={handleMapClickAdd}
          />
        </div>

        {/* Right Side: Scorecard & Analytics Panel */}
        <div className="w-full lg:w-[420px] xl:w-[460px] h-[360px] lg:h-full shrink-0 shadow-2xl z-20">
          <AnalyticsPanel
            pelangganList={filteredPelanggan}
            allPelanggan={pelangganList}
            salesList={SALES_LIST}
            zonasList={ZONA_LIST}
            onSelectPelanggan={setSelectedPelanggan}
          />
        </div>
      </div>

      {/* Floating Toast Notification */}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-50 bg-slate-900/95 border border-sky-500/40 text-white px-4 py-2.5 rounded-xl shadow-2xl text-xs flex items-center gap-2 backdrop-blur-md animate-fade-in">
          <CheckCircle className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Modals */}
      <GoogleSheetsSyncModal
        isOpen={isSheetsSyncOpen}
        onClose={() => setIsSheetsSyncOpen(false)}
        onDataLoaded={handleDataLoadedFromSheets}
        pipelineList={pipelineList}
        autoSyncActive={autoSyncActive}
        onToggleAutoSync={(active, sec) => {
          setAutoSyncActive(active);
          setSyncIntervalSeconds(sec);
          showToast(
            active
              ? `Auto-Sync aktif: Memeriksa Google Sheets setiap ${sec} detik`
              : 'Auto-Sync dinonaktifkan'
          );
        }}
        savedSheetUrl={savedSheetUrl}
        onSaveSheetUrl={(url) => {
          setSavedSheetUrl(url);
          localStorage.setItem('aetra_sheets_url', url);
        }}
      />

      <UploadModal
        isOpen={isUploadOpen}
        onClose={() => setIsUploadOpen(false)}
        onAddPipeline={handleAddPipeline}
      />

      <AddPelangganModal
        isOpen={isAddOpen}
        onClose={() => setIsAddOpen(false)}
        onSave={handleAddPelanggan}
        zonas={ZONA_LIST}
        salesList={SALES_LIST}
        pipelineList={pipelineList}
        initialLat={addCoordinates.lat}
        initialLng={addCoordinates.lng}
      />

      <GuideModal
        isOpen={isGuideOpen}
        onClose={() => setIsGuideOpen(false)}
      />

      <SupabaseModal
        isOpen={isSupabaseOpen}
        onClose={() => setIsSupabaseOpen(false)}
        config={supabaseConfig}
        onSaveConfig={(cfg) => {
          setSupabaseConfig(cfg);
          localStorage.setItem('aetra_supabase_config', JSON.stringify(cfg));
          showToast('Konfigurasi Supabase berhasil diperbarui');
        }}
      />
    </div>
  );
}
