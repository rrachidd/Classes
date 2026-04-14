/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as XLSX from 'xlsx';
import { Chart, registerables } from 'chart.js';
import ChartDataLabels from 'chartjs-plugin-datalabels';
import { auth, db, loginWithGoogle, logout } from './firebase';
import { useAuthState } from 'react-firebase-hooks/auth';
import { collection, addDoc, query, where, orderBy, onSnapshot, serverTimestamp, Timestamp, updateDoc, doc, getDocs } from 'firebase/firestore';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { LogOut, User, FileText, Download, Trash2, Plus, History, Loader2, BarChart3, Users, CheckCircle2, XCircle, TrendingUp, Trophy, TrendingDown, ChevronRight, Gavel, ChevronDown } from 'lucide-react';

Chart.register(...registerables, ChartDataLabels);

// --- Types ---
const DEFAULT_SUBJECTS = [
  'اللغة العربية', 'اللغة الفرنسية', 'الرياضيات', 'العلوم الفيزيائية',
  'علوم الحياة والأرض', 'التربية الإسلامية', 'الاجتماعيات', 'التربية البدنية',
  'التكنولوجيا', 'التربية التشكيلية', 'المعلوميات', 'اللغة الإنجليزية'
];

interface Student {
  id: string;
  name: string;
  gender: string;
  grade: number | null;
  rank?: number;
  className?: string;
}

interface AnalysisInfo {
  school: string;
  level: string;
  class: string;
  year: string;
  academy: string;
}

interface Teacher {
  subject: string;
  name: string;
  className?: string;
}

interface Analysis {
  id?: string;
  userId: string;
  createdAt: any;
  info: AnalysisInfo;
  students: Student[];
  teachers?: Teacher[];
}

// --- Helpers ---
const isId = (v: any) => v && /^[A-Z]{1,2}\d{7,12}$/i.test(String(v).trim());

const median = (arr: number[]) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const stdDev = (arr: number[], avg: number) => {
  if (!arr.length) return 0;
  return Math.sqrt(arr.reduce((a, v) => a + Math.pow(v - avg, 2), 0) / arr.length);
};

const parseGrade = (v: any) => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim().replace(',', '.');
  const n = parseFloat(s);
  return (!isNaN(n) && n >= 0 && n <= 20) ? Math.round(n * 100) / 100 : null;
};

const parseSheet = (rows: any[][]) => {
  const info: AnalysisInfo = { school: '', level: '', class: '', year: '', academy: '' };
  const students: Student[] = [];

  for (let i = 0; i < Math.min(rows.length, 40); i++) {
    const row = rows[i];
    if (!row) continue;
    
    for (let j = 0; j < row.length; j++) {
      const cell = row[j];
      const c = String(cell || '').trim();
      if (!c) continue;

      // Academy / Delegation
      if ((c.includes('أكاديمية') || c.includes('جهة') || c.includes('المديرية الإقليمية') || c.includes('وزارة التربية')) && c.length < 100) {
        info.academy = info.academy || c;
      }
      
      // School Name
      if ((c.includes('الثانوية') || c.includes('الإعدادية') || c.includes('الابتدائية') || c.includes('مدرسة')) && c.length < 80 && !c.includes('المستوى')) {
        info.school = info.school || c;
      }

      // Level / Year
      if ((c.includes('المستوى') || c.includes('السنة') || c.includes('جذع مشترك') || c.includes('باكالوريا') || c.includes('إعدادي') || c.includes('ثانوي')) && c.length < 80) {
        // If it's a label like "المستوى :", try to get the next cell
        if ((c === 'المستوى' || c === 'المستوى :' || c === 'السنة' || c === 'السنة :') && row[j+1]) {
          info.level = info.level || String(row[j+1]).trim();
        } else {
          info.level = info.level || c;
        }
      }

      // School Year
      if (/\d{4}\/\d{4}/.test(c)) {
        info.year = info.year || (c.match(/\d{4}\/\d{4}/)?.[0] || '');
      }

      // Class
      if (/^\d\s*[A-Z]{2,}/.test(c) || (c.includes('القسم') && c.length < 40)) {
        if (c.includes('القسم')) {
          const parts = c.split(/[:\s]+/);
          const last = parts[parts.length - 1];
          if (last && last !== 'القسم' && last.length > 1) {
            info.class = info.class || last;
          } else if (row[j+1]) {
            info.class = info.class || String(row[j+1]).trim();
          }
        } else {
          info.class = info.class || c;
        }
      }
    }
  }

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let idCol = -1;
    for (let j = 0; j < row.length; j++) {
      if (isId(row[j])) { idCol = j; break; }
    }
    if (idCol < 0) continue;

    const id = String(row[idCol]).trim().toUpperCase();
    const name = String(row[idCol + 1] || '').trim();
    if (!name) continue;

    let gender = '';
    for (const cell of row) {
      const c = String(cell).trim();
      if (c === 'ذكر' || c === 'أنثى') { gender = c; break; }
    }

    let grade = null;
    for (let j = idCol + 2; j < row.length; j++) {
      const raw = String(row[j]).trim();
      if (/^\d{1,2},\d{2}$/.test(raw)) { grade = parseGrade(raw); break; }
    }
    if (grade === null) {
      for (let j = idCol + 2; j < row.length; j++) {
        const g = parseGrade(row[j]);
        if (g !== null) {
          const raw = String(row[j]).trim();
          if (raw.includes('.') || raw.includes(',') || (typeof row[j] === 'number' && !Number.isInteger(row[j]))) {
            grade = g; break;
          }
        }
      }
    }

    const sClass = info.class ? info.class.trim() : '';

    const existing = students.find(s => s.id === id);
    if (!existing) {
      students.push({ id, name, gender, grade, className: sClass });
    } else {
      if (grade !== null && existing.grade === null) existing.grade = grade;
      if (gender && !existing.gender) existing.gender = gender;
      if (sClass && !existing.className) existing.className = sClass;
    }
  }

  return { info, students };
};

// Council Report Component for PDF Generation
const CouncilReport = ({ analysis, className, students, teachers, stats, page1Id, page2Id }: { 
  analysis: Analysis, 
  className: string, 
  students: Student[], 
  teachers: Teacher[], 
  stats: any,
  page1Id?: string,
  page2Id?: string
}) => {
  return (
    <div className="space-y-12">
      {/* Page 1: Students List */}
      <div id={page1Id} className="a4-sheet mx-auto bg-white shadow-lg p-10 text-right" dir="rtl">
        <div className="border-b-2 border-slate-900 pb-6 mb-8 flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-black text-slate-900 mb-2">محضر مجلس القسم - الصفحة 1</h1>
            <p className="text-slate-600 font-bold">{analysis.info.school}</p>
            <p className="text-slate-500">{analysis.info.level} - {className === 'all' ? 'جميع الأقسام' : className}</p>
          </div>
          <div className="text-left">
            <p className="text-sm text-slate-400">السنة الدراسية: {analysis.info.year}</p>
            <p className="text-sm text-slate-400">عدد التلاميذ: {stats.n}</p>
          </div>
        </div>

        <h3 className="font-bold mb-4 text-slate-800 border-r-4 border-emerald-500 pr-3">لائحة نتائج التلاميذ وقرارات المجلس:</h3>
        <table className="w-full border-collapse border border-slate-300 text-sm">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-300 p-2 text-center w-12">الرقم</th>
              <th className="border border-slate-300 p-2 text-right">الاسم والنسب</th>
              <th className="border border-slate-300 p-2 text-center w-16">الجنس</th>
              <th className="border border-slate-300 p-2 text-center w-20">المعدل</th>
              <th className="border border-slate-300 p-2 text-right">قرار المجلس / ملاحظات</th>
            </tr>
          </thead>
          <tbody>
            {students.map((s, idx) => (
              <tr key={s.id}>
                <td className="border border-slate-300 p-2 text-center">{idx + 1}</td>
                <td className="border border-slate-300 p-2 font-medium">{s.name}</td>
                <td className="border border-slate-300 p-2 text-center">{s.gender}</td>
                <td className="border border-slate-300 p-2 text-center font-bold">{s.grade?.toFixed(2) || '—'}</td>
                <td className="border border-slate-300 p-2 text-xs italic text-slate-400">
                  {s.grade && s.grade >= 10 ? 'ينتقل' : 'يكرر'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="mt-8 text-left text-xs text-slate-400">الصفحة 1 من 2</div>
      </div>

      {/* Page 2: Stats & Teachers */}
      <div id={page2Id} className="a4-sheet mx-auto bg-white shadow-lg p-10 text-right" dir="rtl">
        <div className="border-b-2 border-slate-900 pb-6 mb-8 flex justify-between items-start">
          <div>
            <h1 className="text-2xl font-black text-slate-900 mb-2">محضر مجلس القسم - الصفحة 2</h1>
            <p className="text-slate-600 font-bold">{analysis.info.school}</p>
            <p className="text-slate-500">{analysis.info.level} - {className === 'all' ? 'جميع الأقسام' : className}</p>
          </div>
          <div className="text-left">
            <p className="text-sm text-slate-400">تاريخ الاجتماع: {new Date().toLocaleDateString('ar-MA')}</p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-8 mb-10">
          <div className="border border-slate-200 p-4 rounded-xl">
            <h3 className="font-bold mb-4 text-blue-700 border-b pb-2">إحصائيات عامة:</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between"><span>معدل القسم:</span> <span className="font-bold">{stats.avg.toFixed(2)}</span></div>
              <div className="flex justify-between"><span>نسبة النجاح:</span> <span className="font-bold text-green-600">{((stats.pass / stats.n) * 100).toFixed(1)}%</span></div>
              <div className="flex justify-between"><span>أعلى معدل:</span> <span className="font-bold text-blue-600">{stats.max.toFixed(2)}</span></div>
              <div className="flex justify-between"><span>أدنى معدل:</span> <span className="font-bold text-red-600">{stats.min.toFixed(2)}</span></div>
            </div>
          </div>
          <div className="border border-slate-200 p-4 rounded-xl">
            <h3 className="font-bold mb-4 text-purple-700 border-b pb-2">الثلاثة الأوائل:</h3>
            <div className="space-y-2 text-sm">
              {students.slice(0, 3).map((s, i) => (
                <div key={i} className="flex justify-between items-center">
                  <span className="flex items-center gap-2">
                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] text-white ${i === 0 ? 'bg-yellow-500' : i === 1 ? 'bg-slate-400' : 'bg-orange-400'}`}>{i + 1}</span>
                    {s.name}
                  </span>
                  <span className="font-bold">{s.grade?.toFixed(2)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <h3 className="font-bold mb-4 text-slate-800 border-r-4 border-blue-500 pr-3">جدول الأساتذة والتوقيعات:</h3>
        <table className="w-full border-collapse border border-slate-300 text-sm mb-10">
          <thead>
            <tr className="bg-slate-100">
              <th className="border border-slate-300 p-2 text-right">المادة المدرسة</th>
              <th className="border border-slate-300 p-2 text-right">اسم الأستاذ(ة)</th>
              <th className="border border-slate-300 p-2 text-center w-32">التوقيع</th>
            </tr>
          </thead>
          <tbody>
            {teachers.map((t, i) => (
              <tr key={i}>
                <td className="border border-slate-300 p-2 font-bold">{t.subject}</td>
                <td className="border border-slate-300 p-2">{t.name}</td>
                <td className="border border-slate-300 p-2 h-12"></td>
              </tr>
            ))}
            {teachers.length === 0 && (
              <tr>
                <td colSpan={3} className="border border-slate-300 p-4 text-center text-slate-400 italic">يرجى إدخال أسماء الأساتذة في صفحة النتائج ليظهروا هنا.</td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="border border-slate-200 p-4 rounded-xl mb-10">
          <h3 className="font-bold mb-2 text-slate-700">ملاحظات وقرارات إضافية:</h3>
          <div className="h-32 border-2 border-dashed border-slate-100 rounded-lg"></div>
        </div>

        <div className="mt-12 pt-8 border-t border-slate-200 flex justify-between items-center text-sm text-slate-400">
          <p>توقيع السيد المدير</p>
          <p>توقيع الحارس العام</p>
          <p>الصفحة 2 من 2</p>
        </div>
      </div>
    </div>
  );
};

export default function App() {
  const [user, loadingAuth] = useAuthState(auth);
  const [currentAnalysis, setCurrentAnalysis] = useState<Analysis | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [view, setView] = useState<'upload' | 'results'>('upload');
  const [showComparison, setShowComparison] = useState(false);
  const [showInvestment, setShowInvestment] = useState(false);
  const [showCouncilModal, setShowCouncilModal] = useState(false);
  const [isGeneratingAll, setIsGeneratingAll] = useState(false);
  
  // Filters
  const [search, setSearch] = useState('');
  const [filterGen, setFilterGen] = useState('all');
  const [filterSt, setFilterSt] = useState('all');
  const [selectedClass, setSelectedClass] = useState<string>('all');
  const [sortField, setSortField] = useState('grade');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Charts refs
  const chartDistRef = useRef<HTMLCanvasElement>(null);
  const chartPFRef = useRef<HTMLCanvasElement>(null);
  const chartGenRef = useRef<HTMLCanvasElement>(null);
  const chartTopRef = useRef<HTMLCanvasElement>(null);
  const charts = useRef<{ [key: string]: Chart }>({});

  // Fetch current analysis
  useEffect(() => {
    if (!user) return;
    const q = query(
      collection(db, 'analyses'),
      where('userId', '==', user.uid),
      orderBy('createdAt', 'desc')
    );
    const unsub = onSnapshot(q, (snapshot) => {
      if (!snapshot.empty) {
        const data = { id: snapshot.docs[0].id, ...snapshot.docs[0].data() } as Analysis;
        setCurrentAnalysis(data);
        setView('results');
      }
    });
    return () => unsub();
  }, [user]);

  const classes = useMemo(() => {
    if (!currentAnalysis) return [];
    const fromStudents = currentAnalysis.students.map(s => s.className?.trim()).filter(Boolean);
    const fromInfo = currentAnalysis.info.class ? currentAnalysis.info.class.split(/[،,]/).map(c => c.trim()).filter(Boolean) : [];
    const set = new Set([...fromStudents, ...fromInfo]);
    return Array.from(set).sort() as string[];
  }, [currentAnalysis]);

  // Handle File Upload
  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || !user) return;
    setLoading(true);
    setError('');
    
    let batchStudents: Student[] = [];
    let batchInfo: AnalysisInfo = { school: '', level: '', class: '', year: '', academy: '' };
    
    try {
      const files = Array.from(fileList);
      for (const file of files) {
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data, { type: 'array' });
        
        for (const sn of wb.SheetNames) {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' }) as any[][];
          const res = parseSheet(rows);
          
          if (res.info.school) batchInfo.school = batchInfo.school || res.info.school;
          if (res.info.level) batchInfo.level = batchInfo.level || res.info.level;
          if (res.info.year) batchInfo.year = batchInfo.year || res.info.year;
          if (res.info.academy) batchInfo.academy = batchInfo.academy || res.info.academy;
          if (res.info.class) {
            const cls = res.info.class.trim();
            const current = batchInfo.class ? batchInfo.class.split(/[،,]/).map(c => c.trim()) : [];
            if (!current.includes(cls)) {
              current.push(cls);
              batchInfo.class = current.join('، ');
            }
          }

          res.students.forEach(s => {
            const ex = batchStudents.find(x => x.id === s.id);
            if (!ex) {
              batchStudents.push(s);
            } else {
              if (s.grade !== null && (ex.grade === null || s.grade > ex.grade)) ex.grade = s.grade;
              if (s.gender && !ex.gender) ex.gender = s.gender;
              if (!ex.name || (s.name && s.name.length > ex.name.length)) ex.name = s.name;
            }
          });
        }
      }

      if (batchStudents.length === 0) {
        setError('لم يتم العثور على بيانات صالحة في الملفات المختارة.');
        setLoading(false);
        return;
      }

      // Calculate ranks
      const wg = batchStudents.filter(s => s.grade !== null);
      wg.sort((a, b) => (b.grade || 0) - (a.grade || 0));
      wg.forEach((s, i) => { s.rank = i + 1; });
      batchStudents.forEach(s => { if (s.grade === null) s.rank = batchStudents.length; });

      const newAnalysis: Analysis = {
        userId: user.uid,
        createdAt: serverTimestamp(),
        info: batchInfo,
        students: batchStudents
      };

      // Save to Firestore (Update existing or add new)
      try {
        const q = query(collection(db, 'analyses'), where('userId', '==', user.uid));
        const snapshot = await getDocs(q);
        
        if (!snapshot.empty) {
          // Update the first one found
          const docId = snapshot.docs[0].id;
          await updateDoc(doc(db, 'analyses', docId), {
            ...newAnalysis,
            createdAt: serverTimestamp() // Update timestamp
          });
          setCurrentAnalysis({ ...newAnalysis, id: docId });
        } else {
          // Create new
          const docRef = await addDoc(collection(db, 'analyses'), newAnalysis);
          setCurrentAnalysis({ ...newAnalysis, id: docRef.id });
        }
        setView('results');
      } catch (ex: any) {
        setError('حدث خطأ أثناء حفظ البيانات: ' + ex.message);
      }
    } catch (ex: any) {
      setError('حدث خطأ: ' + ex.message);
    } finally {
      setLoading(false);
    }
  };

  // Append more files to current analysis
  const appendFiles = async (fileList: FileList | null) => {
    if (!fileList || !user || !currentAnalysis) return;
    setLoading(true);
    setError('');
    
    let batchStudents = [...currentAnalysis.students];
    let batchInfo = { ...currentAnalysis.info };
    
    try {
      const files = Array.from(fileList);
      for (const file of files) {
        const data = await file.arrayBuffer();
        const wb = XLSX.read(data, { type: 'array' });
        
        for (const sn of wb.SheetNames) {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, defval: '' }) as any[][];
          const res = parseSheet(rows);
          
          if (res.info.school) batchInfo.school = batchInfo.school || res.info.school;
          if (res.info.level) batchInfo.level = batchInfo.level || res.info.level;
          if (res.info.year) batchInfo.year = batchInfo.year || res.info.year;
          if (res.info.academy) batchInfo.academy = batchInfo.academy || res.info.academy;
          if (res.info.class) {
            const cls = res.info.class.trim();
            const current = batchInfo.class ? batchInfo.class.split(/[،,]/).map(c => c.trim()) : [];
            if (!current.includes(cls)) {
              current.push(cls);
              batchInfo.class = current.join('، ');
            }
          }

          res.students.forEach(s => {
            const ex = batchStudents.find(x => x.id === s.id);
            if (!ex) {
              batchStudents.push(s);
            } else {
              if (s.grade !== null && (ex.grade === null || s.grade > ex.grade)) ex.grade = s.grade;
              if (s.gender && !ex.gender) ex.gender = s.gender;
              if (!ex.name || (s.name && s.name.length > ex.name.length)) ex.name = s.name;
            }
          });
        }
      }

      // Re-calculate ranks
      const wg = batchStudents.filter(s => s.grade !== null);
      wg.sort((a, b) => (b.grade || 0) - (a.grade || 0));
      wg.forEach((s, i) => { s.rank = i + 1; });
      batchStudents.forEach(s => { if (s.grade === null) s.rank = batchStudents.length; });

      // Update in Firestore
      if (currentAnalysis.id) {
        await updateDoc(doc(db, 'analyses', currentAnalysis.id), {
          info: batchInfo,
          students: batchStudents
        });
      }
      
      setCurrentAnalysis({ ...currentAnalysis, info: batchInfo, students: batchStudents });
    } catch (ex: any) {
      setError('حدث خطأ أثناء الدمج: ' + ex.message);
    } finally {
      setLoading(false);
    }
  };

  const removeClass = async (className: string) => {
    if (!currentAnalysis || !user) return;
    
    const target = className.trim();
    if (!target) return;

    setLoading(true);
    try {
      // 1. Filter out students belonging to this class
      const remainingStudents = currentAnalysis.students.filter(s => {
        const sClass = (s.className || '').trim();
        return sClass !== target;
      });

      // 2. Update the class list in info
      const currentClasses = currentAnalysis.info.class 
        ? currentAnalysis.info.class.split(/[،,]/).map(c => c.trim()).filter(Boolean) 
        : [];
      const remainingClasses = currentClasses.filter(c => c !== target);
      
      const newClassInfo = remainingClasses.join('، ');
      const newInfo = { ...currentAnalysis.info, class: newClassInfo };
      
      // 3. Recalculate ranks for the remaining students
      const gradedStudents = remainingStudents.filter(s => s.grade !== null);
      gradedStudents.sort((a, b) => (b.grade || 0) - (a.grade || 0));
      gradedStudents.forEach((s, i) => { s.rank = i + 1; });
      
      const maxRank = gradedStudents.length;
      remainingStudents.forEach(s => { 
        if (s.grade === null) s.rank = maxRank + 1; 
      });

      // 4. Update teachers - remove teachers of the deleted class
      const remainingTeachers = (currentAnalysis.teachers || []).filter(t => t.className !== target);

      // 5. Update Firestore
      if (currentAnalysis.id) {
        await updateDoc(doc(db, 'analyses', currentAnalysis.id), {
          info: newInfo,
          students: remainingStudents,
          teachers: remainingTeachers
        });
      }
      
      // 6. Update local state
      setCurrentAnalysis({ 
        ...currentAnalysis, 
        info: newInfo, 
        students: remainingStudents,
        teachers: remainingTeachers
      });
      setSelectedClass('all');
    } catch (ex: any) {
      setError('حدث خطأ أثناء الحذف: ' + ex.message);
    } finally {
      setLoading(false);
    }
  };

  // Stats Calculation
  const stats = useMemo(() => {
    if (!currentAnalysis) return null;
    const targetClass = selectedClass.trim();
    let students = currentAnalysis.students;
    if (selectedClass !== 'all') {
      students = students.filter(s => (s.className?.trim() || '') === targetClass);
    }
    const wg = students.filter(s => s.grade !== null);
    const gs = wg.map(s => s.grade as number);
    const n = students.length;
    const pass = wg.filter(s => (s.grade || 0) >= 10).length;
    const fail = wg.filter(s => (s.grade || 0) < 10).length;
    const avg = gs.length ? gs.reduce((a, b) => a + b, 0) / gs.length : 0;
    const max = gs.length ? Math.max(...gs) : 0;
    const min = gs.length ? Math.min(...gs) : 0;
    const fem = students.filter(s => s.gender === 'أنثى').length;
    const mal = students.filter(s => s.gender === 'ذكر').length;
    
    // New metrics
    const med = median(gs);
    const sd = stdDev(gs, avg);
    const range = max - min;
    
    const wgFem = wg.filter(s => s.gender === 'أنثى');
    const wgMal = wg.filter(s => s.gender === 'ذكر');
    
    const passFem = wgFem.filter(s => (s.grade || 0) >= 10).length;
    const passMal = wgMal.filter(s => (s.grade || 0) >= 10).length;
    
    const rateFem = wgFem.length ? (passFem / wgFem.length * 100) : 0;
    const rateMal = wgMal.length ? (passMal / wgMal.length * 100) : 0;
    
    const avgFem = wgFem.length ? (wgFem.reduce((a, s) => a + (s.grade || 0), 0) / wgFem.length) : 0;
    const avgMal = wgMal.length ? (wgMal.reduce((a, s) => a + (s.grade || 0), 0) / wgMal.length) : 0;
    
    const categories = [
      { l: 'ممتاز (≥ 16)', c: '#059669', count: wg.filter(s => (s.grade || 0) >= 16).length },
      { l: 'جيد جداً (14–16)', c: '#10b981', count: wg.filter(s => (s.grade || 0) >= 14 && (s.grade || 0) < 16).length },
      { l: 'جيد (12–14)', c: '#3b82f6', count: wg.filter(s => (s.grade || 0) >= 12 && (s.grade || 0) < 14).length },
      { l: 'مقبول (10–12)', c: '#f59e0b', count: wg.filter(s => (s.grade || 0) >= 10 && (s.grade || 0) < 12).length },
      { l: 'دون المعدل (8–10)', c: '#f97316', count: wg.filter(s => (s.grade || 0) >= 8 && (s.grade || 0) < 10).length },
      { l: 'ضعيف (< 8)', c: '#ef4444', count: wg.filter(s => (s.grade || 0) < 8).length },
    ];

    return { n, pass, fail, avg, max, min, fem, mal, wg, gs, med, sd, range, rateFem, rateMal, avgFem, avgMal, categories };
  }, [currentAnalysis, selectedClass]);

  // Charts Effect
  useEffect(() => {
    if (view !== 'results' || !stats || !currentAnalysis) return;

    const destroy = () => Object.values(charts.current).forEach(c => {
      if (c instanceof Chart) c.destroy();
    });
    destroy();

    // Distribution
    if (chartDistRef.current) {
      const rngs = [
        { l: '0–4', mn: 0, mx: 4.99, c: '#ef4444' }, { l: '5–6', mn: 5, mx: 6.99, c: '#f97316' },
        { l: '7–8', mn: 7, mx: 7.99, c: '#f59e0b' }, { l: '8–9', mn: 8, mx: 9.99, c: '#eab308' },
        { l: '10–11', mn: 10, mx: 11.99, c: '#84cc16' }, { l: '12–13', mn: 12, mx: 13.99, c: '#22c55e' },
        { l: '14–15', mn: 14, mx: 15.99, c: '#10b981' }, { l: '16–20', mn: 16, mx: 20, c: '#059669' }
      ];
      charts.current.dist = new Chart(chartDistRef.current, {
        type: 'bar',
        data: {
          labels: rngs.map(r => r.l),
          datasets: [{
            data: rngs.map(r => stats.wg.filter(s => (s.grade || 0) >= r.mn && (s.grade || 0) <= r.mx).length),
            backgroundColor: rngs.map(r => r.c), borderRadius: 6
          }]
        },
        options: { 
          responsive: true, 
          maintainAspectRatio: false, 
          plugins: { 
            legend: { display: false },
            datalabels: {
              anchor: 'end',
              align: 'top',
              formatter: (v: any) => v || '',
              font: { weight: 'bold' },
              color: '#475569'
            }
          } 
        }
      });
    }

    // Pass/Fail
    if (chartPFRef.current) {
      charts.current.pf = new Chart(chartPFRef.current, {
        type: 'doughnut',
        data: {
          labels: ['ناجحون', 'راسبون'],
          datasets: [{ data: [stats.pass, stats.fail], backgroundColor: ['#22c55e', '#ef4444'] }]
        },
        options: { 
          responsive: true, 
          maintainAspectRatio: false, 
          cutout: '65%', 
          plugins: { 
            legend: { position: 'bottom' },
            datalabels: {
              formatter: (v: any) => v || '',
              color: '#fff',
              font: { weight: 'bold' }
            }
          } 
        }
      });
    }

    // Gender
    if (chartGenRef.current) {
      charts.current.gen = new Chart(chartGenRef.current, {
        type: 'doughnut',
        data: {
          labels: ['إناث', 'ذكور'],
          datasets: [{ data: [stats.fem, stats.mal], backgroundColor: ['#ec4899', '#3b82f6'] }]
        },
        options: { 
          responsive: true, 
          maintainAspectRatio: false, 
          cutout: '65%', 
          plugins: { 
            legend: { position: 'bottom' },
            datalabels: {
              formatter: (v: any) => v || '',
              color: '#fff',
              font: { weight: 'bold' }
            }
          } 
        }
      });
    }

    // Top 10
    if (chartTopRef.current) {
      const top = [...stats.wg].sort((a, b) => (b.grade || 0) - (a.grade || 0)).slice(0, 10);
      charts.current.top = new Chart(chartTopRef.current, {
        type: 'bar',
        data: {
          labels: top.map(s => s.name.split(' ')[0]),
          datasets: [{
            label: 'المعدل',
            data: top.map(s => s.grade),
            backgroundColor: top.map(s => (s.grade || 0) >= 16 ? '#059669' : '#2563eb'),
            borderRadius: 5
          }]
        },
        options: { 
          responsive: true, 
          maintainAspectRatio: false, 
          indexAxis: 'y', 
          plugins: { 
            legend: { display: false },
            datalabels: {
              anchor: 'end',
              align: 'right',
              formatter: (v: any) => v?.toFixed(2) || '',
              font: { weight: 'bold' },
              color: '#475569'
            }
          } 
        }
      });
    }

    return destroy;
  }, [view, stats, currentAnalysis]);

  // Table Filtering
  const filteredStudents = useMemo(() => {
    if (!currentAnalysis) return [];
    const targetClass = selectedClass.trim();
    let res = currentAnalysis.students.filter(s => {
      if (selectedClass !== 'all' && (s.className?.trim() || '') !== targetClass) return false;
      if (search && !s.name.includes(search) && !s.id.toLowerCase().includes(search.toLowerCase())) return false;
      if (filterGen !== 'all' && s.gender !== filterGen) return false;
      if (filterSt === 'pass' && (s.grade === null || s.grade < 10)) return false;
      if (filterSt === 'fail' && (s.grade === null || s.grade >= 10)) return false;
      return true;
    });

    res.sort((a, b) => {
      let av: any, bv: any;
      if (sortField === 'rank') { av = a.rank ?? 999; bv = b.rank ?? 999; }
      else if (sortField === 'grade') { av = a.grade ?? -1; bv = b.grade ?? -1; }
      else if (sortField === 'status') { av = (a.grade !== null && a.grade >= 10) ? 0 : 1; bv = (b.grade !== null && b.grade >= 10) ? 0 : 1; }
      else { av = String((a as any)[sortField] || ''); bv = String((b as any)[sortField] || ''); }
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    return res;
  }, [currentAnalysis, search, filterGen, filterSt, sortField, sortDir, selectedClass]);

  // PDF Export
  const downloadPDF = async () => {
    const element = document.getElementById('resSec');
    if (!element) return;
    setLoading(true);
    try {
      const canvas = await html2canvas(element, { scale: 2 });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('l', 'mm', 'a4');
      const imgProps = pdf.getImageProperties(imgData);
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (imgProps.height * pdfWidth) / imgProps.width;
      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      const fileName = selectedClass === 'all' ? (currentAnalysis?.info.class || 'تلاميذ') : selectedClass;
      pdf.save(`تحليل_نتائج_${fileName}.pdf`);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  // Comparison Stats
  const comparisonData = useMemo(() => {
    if (!currentAnalysis || !classes.length) return [];
    
    return classes.map(cls => {
      const students = currentAnalysis.students.filter(s => (s.className?.trim() || '') === cls);
      const wg = students.filter(s => s.grade !== null);
      const gs = wg.map(s => s.grade as number);
      const pass = wg.filter(s => (s.grade || 0) >= 10).length;
      const avg = gs.length ? gs.reduce((a, b) => a + b, 0) / gs.length : 0;
      const max = gs.length ? Math.max(...gs) : 0;
      const passRate = students.length ? (pass / students.length * 100) : 0;
      
      return { cls, avg, passRate, max, count: students.length };
    });
  }, [currentAnalysis, classes]);

  const chartCompAvgRef = useRef<HTMLCanvasElement>(null);
  const chartCompPassRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!showComparison || !comparisonData.length) return;

    const destroy = () => {
      if (charts.current.compAvg) charts.current.compAvg.destroy();
      if (charts.current.compPass) charts.current.compPass.destroy();
    };
    destroy();

    const labels = comparisonData.map(d => d.cls);

    if (chartCompAvgRef.current) {
      charts.current.compAvg = new Chart(chartCompAvgRef.current, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: 'المعدل العام',
            data: comparisonData.map(d => d.avg),
            backgroundColor: '#3b82f6',
            borderRadius: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            datalabels: {
              anchor: 'end',
              align: 'top',
              formatter: (v: any) => v.toFixed(2),
              font: { weight: 'bold' }
            }
          }
        }
      });
    }

    if (chartCompPassRef.current) {
      charts.current.compPass = new Chart(chartCompPassRef.current, {
        type: 'bar',
        data: {
          labels,
          datasets: [{
            label: 'نسبة النجاح %',
            data: comparisonData.map(d => d.passRate),
            backgroundColor: '#10b981',
            borderRadius: 6
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: false },
            datalabels: {
              anchor: 'end',
              align: 'top',
              formatter: (v: any) => v.toFixed(1) + '%',
              font: { weight: 'bold' }
            }
          }
        }
      });
    }

    return destroy;
  }, [showComparison, comparisonData]);

  const downloadComparisonPDF = async () => {
    const element = document.getElementById('compSheet');
    if (!element) return;
    setLoading(true);
    try {
      const canvas = await html2canvas(element, { scale: 2 });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      pdf.save(`مقارنة_الأقسام_${currentAnalysis?.info.level || ''}.pdf`);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const investmentInsights = useMemo(() => {
    if (!stats) return null;
    
    const strengths: string[] = [];
    const weaknesses: string[] = [];
    const solutions: string[] = [];

    // Pass Rate
    const passRate = (stats.pass / stats.n) * 100;
    if (passRate >= 75) strengths.push(`نسبة نجاح مرتفعة جداً بلغت ${passRate.toFixed(1)}% مما يدل على تمكن أغلب التلاميذ من الكفايات الأساسية.`);
    else if (passRate >= 50) strengths.push(`نسبة نجاح متوسطة (${passRate.toFixed(1)}%) تستوجب العمل على تحسينها لتشمل فئات أكبر.`);
    else weaknesses.push(`نسبة نجاح متدنية (${passRate.toFixed(1)}%) تشير إلى وجود صعوبات تعلم حقيقية لدى فئة واسعة من التلاميذ.`);

    // Average
    if (stats.avg >= 12) strengths.push(`معدل عام جيد للقسم (${stats.avg.toFixed(2)}) يعكس مستوى تعليمي مرضي.`);
    else if (stats.avg < 10) weaknesses.push(`معدل عام دون العتبة (${stats.avg.toFixed(2)}) يتطلب تدخلات عاجلة.`);

    // SD (Homogeneity)
    if (stats.sd < 2) strengths.push("تجانس ملحوظ في مستويات التلاميذ مما يسهل عملية التدريس الجماعي.");
    else if (stats.sd > 3.5) weaknesses.push("تفاوت كبير في المستويات (انحراف معياري مرتفع) مما يصعب مهمة تدبير الفروقات الفردية.");

    // Gender
    if (stats.rateFem > stats.rateMal + 10) strengths.push("تفوق واضح للإناث في النتائج المحصل عليها.");
    else if (stats.rateMal > stats.rateFem + 10) strengths.push("تفوق واضح للذكور في النتائج المحصل عليها.");

    // Categories
    const weakCount = stats.categories.find(c => c.l === 'ضعيف')?.count || 0;
    if (weakCount > stats.n * 0.3) weaknesses.push(`عدد كبير من التلاميذ في فئة "ضعيف" (${weakCount} تلميذ) يحتاجون لدعم مكثف.`);

    // Solutions
    if (weaknesses.length > 0) {
      solutions.push("تسطير برنامج للدعم التربوي يستهدف التلاميذ المتعثرين في المهارات الأساسية.");
      solutions.push("اعتماد البيداغوجيا الفارقية لتقليص الهوة بين مستويات التلاميذ المتفاوتة.");
    }
    if (strengths.length > 0) {
      solutions.push("تشجيع التلاميذ المتفوقين من خلال لوحات الشرف والتحفيز المعنوي.");
      solutions.push("استثمار قدرات المتفوقين في إطار 'الأستاذ الصغير' لمساعدة زملائهم المتعثرين.");
    }
    solutions.push("تفعيل التواصل مع أولياء الأمور لإشراكهم في تتبع مسار أبنائهم الدراسي.");
    solutions.push("تنظيم حصص للمراجعة الجماعية والتركيز على منهجية الإجابة في الامتحانات.");

    return { strengths, weaknesses, solutions };
  }, [stats]);

  const downloadInvestmentPDF = async () => {
    const element = document.getElementById('investSheet');
    if (!element) return;
    setLoading(true);
    try {
      const canvas = await html2canvas(element, { scale: 2 });
      const imgData = canvas.toDataURL('image/png');
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();
      const pdfHeight = (canvas.height * pdfWidth) / canvas.width;
      pdf.addImage(imgData, 'PNG', 0, 0, pdfWidth, pdfHeight);
      pdf.save(`استثمار_النتائج_${selectedClass === 'all' ? 'المؤسسة' : selectedClass}.pdf`);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const downloadCouncilPDF = async () => {
    const element1 = document.getElementById('councilSheet1');
    const element2 = document.getElementById('councilSheet2');
    if (!element1 || !element2) return;
    setLoading(true);
    try {
      const pdf = new jsPDF('p', 'mm', 'a4');
      const pdfWidth = pdf.internal.pageSize.getWidth();

      // Page 1
      const canvas1 = await html2canvas(element1, { scale: 2 });
      const imgData1 = canvas1.toDataURL('image/png');
      const pdfHeight1 = (canvas1.height * pdfWidth) / canvas1.width;
      pdf.addImage(imgData1, 'PNG', 0, 0, pdfWidth, pdfHeight1);

      pdf.addPage();

      // Page 2
      const canvas2 = await html2canvas(element2, { scale: 2 });
      const imgData2 = canvas2.toDataURL('image/png');
      const pdfHeight2 = (canvas2.height * pdfWidth) / canvas2.width;
      pdf.addImage(imgData2, 'PNG', 0, 0, pdfWidth, pdfHeight2);

      pdf.save(`محضر_مجلس_القسم_${selectedClass === 'all' ? 'المؤسسة' : selectedClass}.pdf`);
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const downloadAllCouncilsPDF = async () => {
    if (!currentAnalysis || classes.length === 0) return;
    setLoading(true);
    setIsGeneratingAll(true);
    
    // Wait for DOM to update
    setTimeout(async () => {
      try {
        const pdf = new jsPDF('p', 'mm', 'a4');
        const pdfWidth = pdf.internal.pageSize.getWidth();

        for (let i = 0; i < classes.length; i++) {
          const c = classes[i];
          const el1 = document.getElementById(`all-council-1-${c}`);
          const el2 = document.getElementById(`all-council-2-${c}`);
          
          if (!el1 || !el2) continue;

          if (i > 0) pdf.addPage();
          
          // Page 1
          const canvas1 = await html2canvas(el1, { scale: 2 });
          const imgData1 = canvas1.toDataURL('image/png');
          const pdfHeight1 = (canvas1.height * pdfWidth) / canvas1.width;
          pdf.addImage(imgData1, 'PNG', 0, 0, pdfWidth, pdfHeight1);

          pdf.addPage();

          // Page 2
          const canvas2 = await html2canvas(el2, { scale: 2 });
          const imgData2 = canvas2.toDataURL('image/png');
          const pdfHeight2 = (canvas2.height * pdfWidth) / canvas2.width;
          pdf.addImage(imgData2, 'PNG', 0, 0, pdfWidth, pdfHeight2);
        }

        pdf.save(`محاضر_مجالس_الأقسام_الجماعية.pdf`);
      } catch (err) {
        console.error(err);
      } finally {
        setLoading(false);
        setIsGeneratingAll(false);
      }
    }, 1000);
  };

  const updateTeachers = async (newTeachers: Teacher[]) => {
    if (!currentAnalysis || !currentAnalysis.id) return;
    try {
      await updateDoc(doc(db, 'analyses', currentAnalysis.id), {
        teachers: newTeachers
      });
      setCurrentAnalysis({ ...currentAnalysis, teachers: newTeachers });
    } catch (ex: any) {
      setError('حدث خطأ أثناء تحديث قائمة الأساتذة: ' + ex.message);
    }
  };

  if (loadingAuth) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50">
        <Loader2 className="w-10 h-10 text-blue-600 animate-spin" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-slate-50 p-4">
        <div className="bg-white rounded-2xl shadow-xl p-8 max-w-md w-full text-center">
          <div className="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-6">
            <BarChart3 className="w-10 h-10 text-blue-600" />
          </div>
          <h1 className="text-2xl font-bold text-slate-900 mb-2">تحليل نتائج التلاميذ</h1>
          <p className="text-slate-500 mb-8">سجل الدخول لحفظ تحليلاتك والوصول إليها من أي مكان</p>
          <button
            onClick={loginWithGoogle}
            className="w-full flex items-center justify-center gap-3 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold py-3 px-4 rounded-xl transition-all shadow-sm"
          >
            <img src="https://www.gstatic.com/firebasejs/ui/2.0.0/images/auth/google.svg" className="w-6 h-6" alt="Google" />
            تسجيل الدخول باستخدام Google
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col">
      <header className="no-print">
        <div className="flex items-center gap-3">
          <BarChart3 className="w-6 h-6" />
          <h1 className="text-xl font-bold">تحليل نتائج التلاميذ</h1>
        </div>
        <div className="flex items-center gap-4">
          {view !== 'upload' && (
            <div className="hidden md:flex items-center gap-2">
              <button 
                onClick={() => { setCurrentAnalysis(null); setView('upload'); }} 
                className="flex items-center gap-2 bg-white/10 hover:bg-white/20 px-3 py-1.5 rounded-lg transition-colors text-sm font-medium"
              >
                <Plus className="w-4 h-4" />
                تحليل جديد
              </button>
              {view === 'results' && classes.length > 1 && (
                <button 
                  onClick={() => setShowComparison(true)} 
                  className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 px-3 py-1.5 rounded-lg transition-colors text-sm font-medium"
                >
                  <BarChart3 className="w-4 h-4" />
                  مقارنة الأقسام
                </button>
              )}
              {view === 'results' && (
                <button 
                  onClick={() => setShowInvestment(true)} 
                  className="flex items-center gap-2 bg-amber-600 hover:bg-amber-700 px-3 py-1.5 rounded-lg transition-colors text-sm font-medium"
                >
                  <TrendingUp className="w-4 h-4" />
                  استثمار النتائج
                </button>
              )}
              {view === 'results' && (
                <button 
                  onClick={() => setShowCouncilModal(true)} 
                  className="flex items-center gap-2 bg-emerald-600 hover:bg-emerald-700 px-3 py-1.5 rounded-lg transition-colors text-sm font-medium"
                >
                  <Gavel className="w-4 h-4" />
                  محاضر المجالس
                </button>
              )}
            </div>
          )}
          <div className="hidden md:flex items-center gap-2 bg-white/10 px-3 py-1.5 rounded-lg">
            <User className="w-4 h-4" />
            <span className="text-sm font-medium">{user.displayName}</span>
          </div>
          <button onClick={logout} className="p-2 hover:bg-white/10 rounded-lg transition-colors text-red-200" title="خروج">
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="flex-1 p-4 md:p-6 max-w-7xl mx-auto w-full">
        {loading && (
          <div className="fixed inset-0 bg-white/80 backdrop-blur-sm z-50 flex flex-col items-center justify-center gap-4">
            <Loader2 className="w-12 h-12 text-blue-600 animate-spin" />
            <p className="text-lg font-medium text-blue-600">جاري المعالجة...</p>
          </div>
        )}

        {view === 'upload' && (
          <div className="flex items-center justify-center min-h-[70vh]">
            <div className="up-card">
              <div className="w-20 h-20 bg-blue-50 rounded-full flex items-center justify-center mx-auto mb-6">
                <FileText className="w-10 h-10 text-blue-600" />
              </div>
              <h2 className="text-2xl font-bold mb-2">تحميل ملفات النتائج</h2>
              <p className="text-slate-500 mb-8">قم بتحميل ملفات Excel الخاصة بمجالس القسم</p>
              
              <label className="drop block">
                <input
                  type="file"
                  className="hidden"
                  multiple
                  accept=".xlsx,.xls"
                  onChange={(e) => handleFiles(e.target.files)}
                />
                <Plus className="w-10 h-10 text-blue-600 mx-auto mb-4" />
                <p className="text-blue-700 font-bold">اسحب وأفلت الملفات هنا</p>
                <small className="text-blue-500">أو انقر للاختيار (xlsx, xls)</small>
              </label>

              {error && (
                <div className="mt-4 p-3 bg-red-50 text-red-600 rounded-lg text-sm font-medium flex items-center gap-2">
                  <XCircle className="w-4 h-4" />
                  {error}
                </div>
              )}
            </div>
          </div>
        )}

        {view === 'results' && currentAnalysis && stats && (
          <div className="flex flex-col lg:flex-row gap-6">
            {/* Sidebar Tools */}
            <aside className="lg:w-64 shrink-0 no-print">
              <div className="bg-white rounded-2xl shadow-sm border border-slate-100 p-4 sticky top-24 space-y-4">
                <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider px-2">أدوات التحليل</h3>
                <nav className="space-y-1">
                  {classes.length > 1 && (
                    <button
                      onClick={() => setShowComparison(true)}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-purple-600 hover:bg-purple-50 transition-all"
                    >
                      <BarChart3 className="w-4 h-4" />
                      مقارنة الأقسام
                    </button>
                  )}
                  <button
                    onClick={() => setShowInvestment(true)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-amber-600 hover:bg-amber-50 transition-all"
                  >
                    <TrendingUp className="w-4 h-4" />
                    استثمار النتائج
                  </button>
                  <button
                    onClick={() => setShowCouncilModal(true)}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-emerald-600 hover:bg-emerald-50 transition-all"
                  >
                    <Gavel className="w-4 h-4" />
                    محاضر مجالس الأقسام
                  </button>
                  {classes.length > 1 && (
                    <button
                      onClick={downloadAllCouncilsPDF}
                      className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-blue-600 hover:bg-blue-50 transition-all"
                    >
                      <Download className="w-4 h-4" />
                      تحميل المحاضر الجماعية
                    </button>
                  )}
                  <button
                    onClick={downloadPDF}
                    className="w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm font-medium text-slate-600 hover:bg-slate-50 transition-all"
                  >
                    <Download className="w-4 h-4" />
                    تحميل التقرير الحالي
                  </button>
                </nav>

                <div className="pt-4 border-t border-slate-50">
                  <h3 className="text-xs font-bold text-slate-400 uppercase tracking-wider px-2 mb-2">اختيار القسم</h3>
                  <div className="relative">
                    <select
                      value={selectedClass}
                      onChange={(e) => setSelectedClass(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2.5 text-sm font-medium text-slate-700 outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-100 transition-all appearance-none cursor-pointer pr-10"
                    >
                      <option value="all">جميع الأقسام 👥</option>
                      {classes.map(c => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                    </select>
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none text-slate-400">
                      <ChevronDown className="w-4 h-4" />
                    </div>
                  </div>
                </div>
              </div>
            </aside>

            {/* Main Content */}
            <div id="resSec" className="flex-1 space-y-6">
              <div className="flex items-center justify-between no-print">
                <div className="flex gap-3">
                  <label className="cursor-pointer text-blue-600 hover:text-blue-700 font-medium flex items-center gap-1">
                    <Plus className="w-4 h-4" />
                    إضافة ملفات أخرى لهذا التحليل
                    <input
                      type="file"
                      className="hidden"
                      multiple
                      accept=".xlsx,.xls"
                      onChange={(e) => appendFiles(e.target.files)}
                    />
                  </label>
                </div>
              </div>

            {/* School Banner */}
            <div className="s-info">
              <div className="s-item"><div className="lbl">المؤسسة</div><div className="val">{currentAnalysis.info.school || '—'}</div></div>
              <div className="s-item"><div className="lbl">المستوى</div><div className="val">{currentAnalysis.info.level || '—'}</div></div>
              <div className="s-item">
                <div className="lbl">القسم</div>
                <div className="val">{selectedClass === 'all' ? (currentAnalysis.info.class || '—') : selectedClass}</div>
              </div>
              <div className="s-item"><div className="lbl">السنة الدراسية</div><div className="val">{currentAnalysis.info.year || '—'}</div></div>
              <div className="s-item"><div className="lbl">الأكاديمية</div><div className="val">{currentAnalysis.info.academy || '—'}</div></div>
            </div>

            {/* Class Selection Tabs */}
            <div className="no-print space-y-0">
              <div className="flex flex-wrap items-end gap-1">
                <label className="cursor-pointer mb-1 ml-2">
                  <div className="btn-add-file">
                    <Plus className="w-5 h-5" />
                    إضافة ملف
                  </div>
                  <input
                    type="file"
                    className="hidden"
                    multiple
                    accept=".xlsx,.xls"
                    onChange={(e) => appendFiles(e.target.files)}
                  />
                </label>

                <button
                  onClick={() => setSelectedClass('all')}
                  className={`tab-btn ${selectedClass === 'all' ? 'active' : ''}`}
                >
                  <Users className="w-4 h-4 ico" />
                  جميع الأقسام
                </button>
                {classes.map(c => (
                  <button
                    key={c}
                    onClick={() => setSelectedClass(c)}
                    className={`tab-btn ${selectedClass === c ? 'active' : ''}`}
                  >
                    <Users className="w-4 h-4 ico" />
                    {c}
                  </button>
                ))}
              </div>

              {selectedClass !== 'all' && (
                <div className="flex justify-end">
                  <button
                    onClick={() => {
                      if (window.confirm(`هل أنت متأكد من حذف القسم "${selectedClass}"؟`)) {
                        removeClass(selectedClass);
                      }
                    }}
                    className="btn-remove-class"
                  >
                    <Trash2 className="w-4 h-4" />
                    إزالة القسم
                  </button>
                </div>
              )}
            </div>

            {/* Stats Cards */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {/* Row 1 */}
              <div className="sc blue"><div className="sico"><Users className="w-6 h-6" /></div><div><div className="sv">{stats.n}</div><div className="sl">إجمالي التلاميذ</div></div></div>
              <div className="sc green"><div className="sico"><CheckCircle2 className="w-6 h-6" /></div><div><div className="sv">{stats.pass}</div><div className="sl">ناجحون (≥10)</div></div></div>
              <div className="sc red"><div className="sico"><XCircle className="w-6 h-6" /></div><div><div className="sv">{stats.fail}</div><div className="sl">راسبون (&lt;10)</div></div></div>
              
              {/* Row 2 */}
              <div className="sc green"><div className="sico"><BarChart3 className="w-6 h-6" /></div><div><div className="sv">{(stats.n ? (stats.pass / stats.n * 100) : 0).toFixed(1)}%</div><div className="sl">نسبة النجاح</div></div></div>
              <div className="sc purple"><div className="sico"><TrendingUp className="w-6 h-6" /></div><div><div className="sv">{stats.avg.toFixed(2)}</div><div className="sl">المعدل العام</div></div></div>
              <div className="sc yellow"><div className="sico"><Trophy className="w-6 h-6" /></div><div><div className="sv">{stats.max.toFixed(2)}</div><div className="sl">أعلى معدل</div></div></div>
              
              {/* Row 3 */}
              <div className="sc red"><div className="sico"><TrendingDown className="w-6 h-6" /></div><div><div className="sv">{stats.min.toFixed(2)}</div><div className="sl">أدنى معدل</div></div></div>
              <div className="sc pink"><div className="sico"><span className="text-2xl">👩</span></div><div><div className="sv">{stats.fem}</div><div className="sl">الإناث</div></div></div>
              <div className="sc blue"><div className="sico"><span className="text-2xl">👦</span></div><div><div className="sv">{stats.mal}</div><div className="sl">الذكور</div></div></div>
            </div>

            {/* Charts */}
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              <div className="cc lg:col-span-2">
                <h3 className="font-bold mb-4 flex items-center gap-2"><BarChart3 className="w-4 h-4 text-blue-600" /> توزيع المعدلات</h3>
                <div className="h-[300px]"><canvas ref={chartDistRef}></canvas></div>
              </div>
              <div className="space-y-6">
                <div className="cc">
                  <h3 className="font-bold mb-4 flex items-center gap-2"><CheckCircle2 className="w-4 h-4 text-green-600" /> نسبة النجاح</h3>
                  <div className="h-[200px]"><canvas ref={chartPFRef}></canvas></div>
                </div>
                <div className="cc">
                  <h3 className="font-bold mb-4 flex items-center gap-2"><Users className="w-4 h-4 text-pink-600" /> توزيع الجنس</h3>
                  <div className="h-[200px]"><canvas ref={chartGenRef}></canvas></div>
                </div>
              </div>
            </div>

            {/* Top 10 */}
            <div className="cc-wide">
              <h3 className="font-bold mb-4 flex items-center gap-2"><Trophy className="w-4 h-4 text-yellow-600" /> أفضل 10 تلاميذ</h3>
              <div className="h-[250px]"><canvas ref={chartTopRef}></canvas></div>
            </div>

            {/* Extra Stats Row */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {/* Categories Distribution */}
              <div className="ecard">
                <h3 className="font-bold mb-6 flex items-center gap-2">
                  <FileText className="w-4 h-4 text-blue-600" /> توزيع الفئات 📋
                </h3>
                <div className="space-y-4">
                  {stats.categories.map((cat, idx) => {
                    const pct = stats.n ? (cat.count / stats.n * 100) : 0;
                    return (
                      <div key={idx} className="db-row">
                        <span className="db-lbl">{cat.l}</span>
                        <div className="db-bar">
                          <div 
                            className="db-fill" 
                            style={{ width: `${Math.max(pct, cat.count > 0 ? 5 : 0)}%`, backgroundColor: cat.c }}
                          >
                            {cat.count > 0 && cat.count}
                          </div>
                        </div>
                        <span className="db-cnt">{cat.count}</span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {/* Supplementary Stats */}
              <div className="ecard">
                <h3 className="font-bold mb-6 flex items-center gap-2">
                  <TrendingUp className="w-4 h-4 text-green-600" /> إحصائيات تكميلية 📈
                </h3>
                <div className="space-y-1">
                  <div className="xrow"><span className="xlbl">الوسيط (Médiane)</span><span className="xval">{stats.med.toFixed(2)}</span></div>
                  <div className="xrow"><span className="xlbl">الانحراف المعياري</span><span className="xval">{stats.sd.toFixed(2)}</span></div>
                  <div className="xrow"><span className="xlbl">الفرق بين أعلى وأدنى معدل</span><span className="xval">{stats.range.toFixed(2)}</span></div>
                  <div className="xrow"><span className="xlbl">نسبة نجاح الإناث</span><span className="xval">{stats.rateFem.toFixed(1)}%</span></div>
                  <div className="xrow"><span className="xlbl">نسبة نجاح الذكور</span><span className="xval">{stats.rateMal.toFixed(1)}%</span></div>
                  <div className="xrow"><span className="xlbl">معدل الإناث</span><span className="xval">{stats.avgFem.toFixed(2)}</span></div>
                  <div className="xrow"><span className="xlbl">معدل الذكور</span><span className="xval">{stats.avgMal.toFixed(2)}</span></div>
                </div>
              </div>
            </div>

            {/* Table */}
            <div className="tc">
              <div className="th no-print">
                <h3 className="font-bold">قائمة التلاميذ</h3>
                <div className="flex flex-wrap gap-3">
                  <select className="fsel" value={selectedClass} onChange={(e) => setSelectedClass(e.target.value)}>
                    <option value="all">جميع الأقسام</option>
                    {classes.map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                  <select className="fsel" value={filterGen} onChange={(e) => setFilterGen(e.target.value)}>
                    <option value="all">كل الجنسين</option>
                    <option value="أنثى">إناث</option>
                    <option value="ذكر">ذكور</option>
                  </select>
                  <select className="fsel" value={filterSt} onChange={(e) => setFilterSt(e.target.value)}>
                    <option value="all">كل الحالات</option>
                    <option value="pass">ناجحون</option>
                    <option value="fail">راسبون</option>
                  </select>
                  <input
                    className="sinput"
                    placeholder="بحث..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                  />
                </div>
              </div>
              <div className="tw">
                <table>
                  <thead>
                    <tr>
                      <th onClick={() => { setSortField('rank'); setSortDir(sortDir === 'asc' ? 'desc' : 'asc'); }}>الترتيب</th>
                      <th onClick={() => { setSortField('id'); setSortDir(sortDir === 'asc' ? 'desc' : 'asc'); }}>رقم التلميذ</th>
                      <th onClick={() => { setSortField('name'); setSortDir(sortDir === 'asc' ? 'desc' : 'asc'); }}>الاسم والنسب</th>
                      <th>الجنس</th>
                      <th onClick={() => { setSortField('grade'); setSortDir(sortDir === 'asc' ? 'desc' : 'asc'); }}>المعدل</th>
                      <th>الحالة</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStudents.map((s) => (
                      <tr key={s.id}>
                        <td><span className={`rbadge ${s.rank === 1 ? 'r1' : s.rank === 2 ? 'r2' : s.rank === 3 ? 'r3' : 'rn'}`}>{s.rank}</span></td>
                        <td className="text-xs text-slate-400">{s.id}</td>
                        <td className="font-medium">{s.name}</td>
                        <td><span className={`genbadge ${s.gender === 'أنثى' ? 'gf2' : 'gm'}`}>{s.gender}</span></td>
                        <td>
                          <span className={`gb ${s.grade !== null ? (s.grade >= 16 ? 'ge' : s.grade >= 12 ? 'gg' : s.grade >= 10 ? 'ga' : 'gf') : ''}`}>
                            {s.grade?.toFixed(2) || '—'}
                          </span>
                        </td>
                        <td>
                          <span className={`sbadge ${s.grade !== null && s.grade >= 10 ? 'sp' : 'sf'}`}>
                            {s.grade !== null ? (s.grade >= 10 ? 'ناجح' : 'راسب') : '—'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Teachers List Section */}
            <div className="tc mt-8">
              <div className="th no-print">
                <h3 className="font-bold flex items-center gap-2">
                  <Users className="w-5 h-5 text-blue-600" />
                  أساتذة القسم (مجالس الأقسام)
                </h3>
                {selectedClass !== 'all' && (
                  <button
                    onClick={() => {
                      const subject = window.prompt('أدخل اسم المادة:');
                      const name = window.prompt('أدخل اسم الأستاذ:');
                      if (subject && name) {
                        const current = currentAnalysis.teachers || [];
                        updateTeachers([...current, { subject, name, className: selectedClass }]);
                      }
                    }}
                    className="btn-add-file text-xs py-1 px-3"
                  >
                    <Plus className="w-4 h-4" />
                    إضافة مادة/أستاذ
                  </button>
                )}
              </div>
              
              {selectedClass === 'all' ? (
                <div className="p-8 text-center bg-slate-50 rounded-2xl border border-dashed border-slate-200 text-slate-400 no-print">
                  <Users className="w-8 h-8 mx-auto mb-2 opacity-20" />
                  <p>يرجى اختيار قسم محدد من القائمة الجانبية لإدخال أو عرض أساتذة القسم.</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 mt-4 no-print">
                  {DEFAULT_SUBJECTS.map(subject => {
                    const teacher = (currentAnalysis.teachers || []).find(t => t.subject === subject && t.className === selectedClass);
                    return (
                      <div key={subject} className="flex flex-col gap-1 p-3 bg-slate-50 rounded-xl border border-slate-100">
                        <span className="text-xs font-bold text-slate-500">{subject}</span>
                        <input
                          type="text"
                          placeholder="اسم الأستاذ..."
                          className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-blue-400 transition-colors"
                          defaultValue={teacher?.name || ''}
                          onBlur={(e) => {
                            const val = e.target.value.trim();
                            const current = currentAnalysis.teachers || [];
                            const idx = current.findIndex(t => t.subject === subject && t.className === selectedClass);
                            if (idx > -1) {
                              if (val === '') {
                                updateTeachers(current.filter((_, i) => i !== idx));
                              } else if (current[idx].name !== val) {
                                const next = [...current];
                                next[idx] = { ...next[idx], name: val };
                                updateTeachers(next);
                              }
                            } else if (val !== '') {
                              updateTeachers([...current, { subject, name: val, className: selectedClass }]);
                            }
                          }}
                        />
                      </div>
                    );
                  })}
                  {(currentAnalysis.teachers || []).filter(t => t.className === selectedClass && !DEFAULT_SUBJECTS.includes(t.subject)).map((t, idx) => (
                    <div key={idx} className="flex flex-col gap-1 p-3 bg-blue-50 rounded-xl border border-blue-100">
                      <div className="flex justify-between items-center">
                        <span className="text-xs font-bold text-blue-600">{t.subject}</span>
                        <button 
                          onClick={() => {
                            const current = currentAnalysis.teachers || [];
                            const realIdx = current.findIndex(x => x.subject === t.subject && x.name === t.name && x.className === selectedClass);
                            if (realIdx > -1) {
                              updateTeachers(current.filter((_, i) => i !== realIdx));
                            }
                          }}
                          className="text-red-400 hover:text-red-600"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      </div>
                      <input
                        type="text"
                        className="bg-white border border-blue-200 rounded-lg px-3 py-1.5 text-sm outline-none focus:border-blue-400 transition-colors"
                        value={t.name}
                        onChange={(e) => {
                          const val = e.target.value;
                          const current = [...(currentAnalysis.teachers || [])];
                          const i = current.findIndex(x => x.subject === t.subject && x.name === t.name && x.className === selectedClass);
                          if (i > -1) {
                            current[i].name = val;
                            setCurrentAnalysis({ ...currentAnalysis, teachers: current });
                          }
                        }}
                        onBlur={() => updateTeachers(currentAnalysis.teachers || [])}
                      />
                    </div>
                  ))}
                </div>
              )}

              {/* Printable version of teachers list */}
              <div className="hidden print-only mt-6">
                <h3 className="font-bold border-b pb-2 mb-4">أساتذة القسم:</h3>
                <div className="grid grid-cols-2 gap-y-2">
                  {(currentAnalysis.teachers || []).filter(t => selectedClass === 'all' || t.className === selectedClass).map((t, i) => (
                    <div key={i} className="text-sm">
                      <span className="font-bold">{t.subject}:</span> {t.name} {selectedClass === 'all' && <span className="text-xs text-slate-400">({t.className})</span>}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      </main>

      {/* Comparison Modal */}
      {showComparison && currentAnalysis && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl my-8 relative">
            <div className="sticky top-0 bg-white border-b border-slate-100 p-4 rounded-t-2xl flex items-center justify-between z-10 no-print">
              <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                <BarChart3 className="w-5 h-5 text-purple-600" />
                مقارنة نتائج الأقسام
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={downloadComparisonPDF}
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-all"
                >
                  <Download className="w-4 h-4" />
                  تحميل PDF
                </button>
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-xl text-sm font-medium transition-all"
                >
                  <FileText className="w-4 h-4" />
                  طباعة
                </button>
                <button
                  onClick={() => setShowComparison(false)}
                  className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-400"
                >
                  <XCircle className="w-6 h-6" />
                </button>
              </div>
            </div>

            <div className="p-8 bg-slate-50 overflow-x-auto">
              <div id="compSheet" className="a4-sheet mx-auto bg-white shadow-lg p-10 text-right" dir="rtl">
                <div className="border-b-2 border-slate-900 pb-6 mb-8 flex justify-between items-start">
                  <div>
                    <h1 className="text-2xl font-black text-slate-900 mb-2">تقرير مقارنة نتائج الأقسام</h1>
                    <p className="text-slate-600 font-bold">{currentAnalysis.info.school}</p>
                    <p className="text-slate-500">{currentAnalysis.info.level} - {currentAnalysis.info.year}</p>
                  </div>
                  <div className="text-left">
                    <p className="text-sm text-slate-400">تاريخ التقرير: {new Date().toLocaleDateString('ar-MA')}</p>
                    <p className="text-sm text-slate-400">عدد الأقسام: {classes.length}</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-10">
                  <div className="cc border border-slate-200 shadow-none">
                    <h3 className="font-bold mb-4 text-blue-700">مقارنة المعدلات العامة</h3>
                    <div className="h-[250px]"><canvas ref={chartCompAvgRef}></canvas></div>
                  </div>
                  <div className="cc border border-slate-200 shadow-none">
                    <h3 className="font-bold mb-4 text-green-700">مقارنة نسب النجاح (%)</h3>
                    <div className="h-[250px]"><canvas ref={chartCompPassRef}></canvas></div>
                  </div>
                </div>

                <div className="mb-10 overflow-x-auto">
                  <table className="w-full border-collapse border border-slate-300">
                    <thead>
                      <tr className="bg-slate-100">
                        <th className="border border-slate-300 p-3 text-right">القسم</th>
                        <th className="border border-slate-300 p-3 text-center">عدد التلاميذ</th>
                        <th className="border border-slate-300 p-3 text-center">المعدل العام</th>
                        <th className="border border-slate-300 p-3 text-center">نسبة النجاح</th>
                        <th className="border border-slate-300 p-3 text-center">أعلى معدل</th>
                      </tr>
                    </thead>
                    <tbody>
                      {comparisonData.map((d, i) => (
                        <tr key={i}>
                          <td className="border border-slate-300 p-3 font-bold">{d.cls}</td>
                          <td className="border border-slate-300 p-3 text-center">{d.count}</td>
                          <td className="border border-slate-300 p-3 text-center font-medium">{d.avg.toFixed(2)}</td>
                          <td className="border border-slate-300 p-3 text-center font-medium text-green-600">{d.passRate.toFixed(1)}%</td>
                          <td className="border border-slate-300 p-3 text-center font-medium text-blue-600">{d.max.toFixed(2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="bg-blue-50 p-6 rounded-xl border border-blue-100">
                  <h3 className="text-lg font-bold text-blue-900 mb-4 flex items-center gap-2">
                    <TrendingUp className="w-5 h-5" />
                    الاستنتاجات والملاحظات العامة:
                  </h3>
                  <ul className="space-y-3 text-blue-800 font-medium">
                    <li className="flex items-start gap-2">
                      <div className="w-2 h-2 rounded-full bg-blue-400 mt-2 shrink-0"></div>
                      <span>أفضل أداء من حيث المعدل العام سُجل في قسم <strong className="text-blue-900 underline">{[...comparisonData].sort((a, b) => b.avg - a.avg)[0]?.cls}</strong> بمعدل <strong className="text-blue-900 underline">{[...comparisonData].sort((a, b) => b.avg - a.avg)[0]?.avg.toFixed(2)}</strong>.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <div className="w-2 h-2 rounded-full bg-blue-400 mt-2 shrink-0"></div>
                      <span>أعلى نسبة نجاح بلغت <strong className="text-green-700 underline">{[...comparisonData].sort((a, b) => b.passRate - a.passRate)[0]?.passRate.toFixed(1)}%</strong> وكانت من نصيب قسم <strong className="text-blue-900 underline">{[...comparisonData].sort((a, b) => b.passRate - a.passRate)[0]?.cls}</strong>.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <div className="w-2 h-2 rounded-full bg-blue-400 mt-2 shrink-0"></div>
                      <span>أعلى معدل فردي على مستوى جميع الأقسام هو <strong className="text-purple-700 underline">{Math.max(...comparisonData.map(d => d.max)).toFixed(2)}</strong>.</span>
                    </li>
                    <li className="flex items-start gap-2">
                      <div className="w-2 h-2 rounded-full bg-blue-400 mt-2 shrink-0"></div>
                      <span>يلاحظ وجود تفاوت في الأداء بين الأقسام بنسبة <strong className="text-red-600 underline">{(Math.max(...comparisonData.map(d => d.avg)) - Math.min(...comparisonData.map(d => d.avg))).toFixed(2)}</strong> نقطة في المعدل العام.</span>
                    </li>
                  </ul>
                </div>

                <div className="mt-12 pt-8 border-t border-slate-200 flex justify-between items-center text-sm text-slate-400">
                  <p>توقيع الإدارة / مجلس القسم</p>
                  <p>الصفحة 1 من 1</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Investment Modal */}
      {showInvestment && currentAnalysis && stats && investmentInsights && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl my-8 relative">
            <div className="sticky top-0 bg-white border-b border-slate-100 p-4 rounded-t-2xl flex items-center justify-between z-10 no-print">
              <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                <TrendingUp className="w-5 h-5 text-amber-600" />
                استثمار نتائج التلاميذ
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={downloadInvestmentPDF}
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-all"
                >
                  <Download className="w-4 h-4" />
                  تحميل PDF
                </button>
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-xl text-sm font-medium transition-all"
                >
                  <FileText className="w-4 h-4" />
                  طباعة
                </button>
                <button
                  onClick={() => setShowInvestment(false)}
                  className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-400"
                >
                  <XCircle className="w-6 h-6" />
                </button>
              </div>
            </div>

            <div className="p-8 bg-slate-50 overflow-x-auto">
              <div id="investSheet" className="a4-sheet mx-auto bg-white shadow-lg p-10 text-right" dir="rtl">
                <div className="border-b-2 border-slate-900 pb-6 mb-8 flex justify-between items-start">
                  <div>
                    <h1 className="text-2xl font-black text-slate-900 mb-2">تقرير استثمار نتائج التلاميذ</h1>
                    <p className="text-slate-600 font-bold">{currentAnalysis.info.school}</p>
                    <p className="text-slate-500">{currentAnalysis.info.level} - {selectedClass === 'all' ? 'جميع الأقسام' : selectedClass}</p>
                  </div>
                  <div className="text-left">
                    <p className="text-sm text-slate-400">تاريخ التقرير: {new Date().toLocaleDateString('ar-MA')}</p>
                    <p className="text-sm text-slate-400">عدد التلاميذ: {stats.n}</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-10 no-print">
                  <div className="p-4 bg-blue-50 rounded-xl border border-blue-100 text-center">
                    <div className="text-2xl font-bold text-blue-600">{stats.avg.toFixed(2)}</div>
                    <div className="text-xs text-blue-400">المعدل العام</div>
                  </div>
                  <div className="p-4 bg-green-50 rounded-xl border border-green-100 text-center">
                    <div className="text-2xl font-bold text-green-600">{((stats.pass / stats.n) * 100).toFixed(1)}%</div>
                    <div className="text-xs text-green-400">نسبة النجاح</div>
                  </div>
                  <div className="p-4 bg-purple-50 rounded-xl border border-purple-100 text-center">
                    <div className="text-2xl font-bold text-purple-600">{stats.sd.toFixed(2)}</div>
                    <div className="text-xs text-purple-400">الانحراف المعياري</div>
                  </div>
                </div>

                <div className="space-y-8">
                  <section>
                    <h3 className="text-lg font-bold text-green-700 mb-4 flex items-center gap-2 border-r-4 border-green-500 pr-3">
                      <CheckCircle2 className="w-5 h-5" />
                      نقاط القوة:
                    </h3>
                    <ul className="space-y-2 mr-4">
                      {investmentInsights.strengths.map((s, i) => (
                        <li key={i} className="flex items-start gap-2 text-slate-700">
                          <div className="w-1.5 h-1.5 rounded-full bg-green-400 mt-2 shrink-0"></div>
                          <span>{s}</span>
                        </li>
                      ))}
                      {investmentInsights.strengths.length === 0 && <li className="text-slate-400 italic">لم يتم تحديد نقاط قوة بارزة بناءً على المعايير الحالية.</li>}
                    </ul>
                  </section>

                  <section>
                    <h3 className="text-lg font-bold text-red-700 mb-4 flex items-center gap-2 border-r-4 border-red-500 pr-3">
                      <XCircle className="w-5 h-5" />
                      نقاط الضعف / التعثرات:
                    </h3>
                    <ul className="space-y-2 mr-4">
                      {investmentInsights.weaknesses.map((w, i) => (
                        <li key={i} className="flex items-start gap-2 text-slate-700">
                          <div className="w-1.5 h-1.5 rounded-full bg-red-400 mt-2 shrink-0"></div>
                          <span>{w}</span>
                        </li>
                      ))}
                      {investmentInsights.weaknesses.length === 0 && <li className="text-slate-400 italic">لم يتم رصد نقاط ضعف حرجة في هذه النتائج.</li>}
                    </ul>
                  </section>

                  <section>
                    <h3 className="text-lg font-bold text-blue-700 mb-4 flex items-center gap-2 border-r-4 border-blue-500 pr-3">
                      <TrendingUp className="w-5 h-5" />
                      الحلول والمقترحات التربوية:
                    </h3>
                    <div className="bg-slate-50 p-6 rounded-2xl border border-slate-200">
                      <ul className="grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3">
                        {investmentInsights.solutions.map((sol, i) => (
                          <li key={i} className="flex items-start gap-2 text-slate-700">
                            <div className="w-1.5 h-1.5 rounded-full bg-blue-400 mt-2 shrink-0"></div>
                            <span>{sol}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  </section>
                </div>

                {currentAnalysis.teachers && currentAnalysis.teachers.filter(t => selectedClass === 'all' || t.className === selectedClass).length > 0 && (
                  <div className="mt-10 border-t pt-6">
                    <h3 className="text-lg font-bold text-slate-800 mb-4 flex items-center gap-2">
                      <Users className="w-5 h-5 text-blue-600" />
                      لائحة أساتذة القسم:
                    </h3>
                    <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
                      {currentAnalysis.teachers.filter(t => selectedClass === 'all' || t.className === selectedClass).map((t, i) => (
                        <div key={i} className="text-sm p-2 bg-slate-50 rounded border border-slate-100">
                          <span className="font-bold text-slate-600">{t.subject}:</span> {t.name}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-16 pt-8 border-t border-slate-200 flex justify-between items-center text-sm text-slate-400">
                  <p>توقيع الأستاذ(ة)</p>
                  <p>توقيع السيد المدير</p>
                  <p>الصفحة 1 من 1</p>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
      {/* Council Modal */}
      {showCouncilModal && currentAnalysis && stats && (
        <div className="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[100] flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-5xl my-8 relative">
            <div className="sticky top-0 bg-white border-b border-slate-100 p-4 rounded-t-2xl flex items-center justify-between z-10 no-print">
              <h2 className="text-xl font-bold text-slate-800 flex items-center gap-2">
                <Gavel className="w-5 h-5 text-emerald-600" />
                محاضر مجالس الأقسام
              </h2>
              <div className="flex items-center gap-2">
                <button
                  onClick={downloadCouncilPDF}
                  className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-xl text-sm font-medium transition-all"
                >
                  <Download className="w-4 h-4" />
                  تحميل PDF
                </button>
                <button
                  onClick={() => window.print()}
                  className="flex items-center gap-2 bg-slate-100 hover:bg-slate-200 text-slate-700 px-4 py-2 rounded-xl text-sm font-medium transition-all"
                >
                  <FileText className="w-4 h-4" />
                  طباعة
                </button>
                <button
                  onClick={() => setShowCouncilModal(false)}
                  className="p-2 hover:bg-slate-100 rounded-full transition-colors text-slate-400"
                >
                  <XCircle className="w-6 h-6" />
                </button>
              </div>
            </div>

            <div className="p-8 bg-slate-50">
              <CouncilReport 
                analysis={currentAnalysis}
                className={selectedClass}
                students={filteredStudents}
                teachers={(currentAnalysis.teachers || []).filter(t => selectedClass === 'all' || t.className === selectedClass)}
                stats={stats}
                page1Id="councilSheet1"
                page2Id="councilSheet2"
              />
            </div>
          </div>
        </div>
      )}

      {/* Hidden container for all councils generation */}
      {isGeneratingAll && currentAnalysis && (
        <div style={{ position: 'absolute', left: '-9999px', top: '-9999px', width: '210mm' }}>
          {classes.map(c => {
            const classStudents = currentAnalysis.students.filter(s => (s.className?.trim() || '') === c);
            const wg = classStudents.filter(s => s.grade !== null);
            const gs = wg.map(s => s.grade as number);
            const n = classStudents.length;
            const pass = wg.filter(s => (s.grade || 0) >= 10).length;
            const fail = wg.filter(s => (s.grade || 0) < 10).length;
            const avg = gs.length ? (gs.reduce((a, b) => a + b, 0) / gs.length) : 0;
            const max = gs.length ? Math.max(...gs) : 0;
            const min = gs.length ? Math.min(...gs) : 0;
            
            const classStats = { n, pass, fail, avg, max, min };
            const classTeachers = (currentAnalysis.teachers || []).filter(t => t.className === c);
            
            // Sort students for the report
            const sortedStudents = [...classStudents].sort((a, b) => (b.grade || 0) - (a.grade || 0));

            return (
              <div key={c} id={`all-council-container-${c}`}>
                <CouncilReport 
                  analysis={currentAnalysis}
                  className={c}
                  students={sortedStudents}
                  teachers={classTeachers}
                  stats={classStats}
                  page1Id={`all-council-1-${c}`}
                  page2Id={`all-council-2-${c}`}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
