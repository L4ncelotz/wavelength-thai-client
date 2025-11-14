import React, { useState, useEffect, useRef } from 'react';
import io from 'socket.io-client';

const SOCKET_SERVER_URL = "https://wavelength-thai-server.onrender.com/"; // **สำคัญ: เปลี่ยนเป็น URL ของ Backend คุณ**

// --- SVG Helper Functions ---
// แปลงค่า 0-100 เป็นองศา 0-180
const valueToAngle = (value) => (value / 100) * 180;

// แปลงองศาเป็นตำแหน่ง x, y บนครึ่งวงกลม (สำหรับปลายเข็ม)
// (0,0) ของ SVG อยู่ที่มุมบนซ้าย, (100, 100) คือจุดศูนย์กลางครึ่งวงกลม
const getPointerPosition = (value, radius = 100) => {
    const angle = valueToAngle(value); // 0-180 degrees
    const rad = ((180 - angle) * Math.PI) / 180; // กลับด้านองศา (0=ซ้าย, 180=ขวา)
    const x = radius * Math.cos(rad);
    const y = radius * Math.sin(rad);
    return { x: x, y: -y }; // Y กลับด้านเพราะ SVG นับ y ลงล่าง
};

// หาช่วงตัวเลขที่ต่อเนื่องกันใน Array
// เช่น [1, 2, 3, 5, 6] => [{start: 1, end: 3}, {start: 5, end: 6}]
function getSegments(arr) {
    if (!arr || arr.length === 0) return [];
    arr.sort((a, b) => a - b);
    const segments = [];
    let start = arr[0];
    let end = arr[0];
    for (let i = 1; i < arr.length; i++) {
        if (arr[i] === end + 1) {
            end = arr[i];
        } else {
            segments.push({ start, end });
            start = arr[i];
            end = arr[i];
        }
    }
    segments.push({ start, end });
    return segments;
}

// Component สำหรับวาดส่วนโค้ง (Arc) ของโซนคะแนน
const ScoreZoneArc = ({ segment, radius, strokeWidth, color }) => {
    // -0.1 และ +0.1 เพื่อให้แน่ใจว่าส่วนโค้งที่ติดกันไม่มีช่องว่าง
    // ขยายขอบเขตเล็กน้อยเพื่อให้แน่ใจว่าส่วนโค้งที่ติดกันไม่มีช่องว่าง
    const startVal = Math.max(0, segment.start - 0.1);
    const endVal = Math.min(100, segment.end + 0.1);

    const startPos = getPointerPosition(startVal, radius);
    const endPos = getPointerPosition(endVal, radius);

    const baseCx = 100;
    const baseCy = 100;

    // 0 = small arc, 1 = large arc
    const largeArcFlag = (endVal - startVal) > 50 ? 1 : 0;

    const d = [
        `M ${startPos.x + baseCx} ${startPos.y + baseCy}`, // Move to start
        `A ${radius} ${radius} 0 ${largeArcFlag} 1 ${endPos.x + baseCx} ${endPos.y + baseCy}` // Arc to end
    ].join(' ');

    return <path d={d} stroke={color} strokeWidth={strokeWidth} fill="none" opacity={0.7} />;
};
// --- จบส่วน Helper ---


function App() {
    const [scoreZones, setScoreZones] = useState(null); // เก็บข้อมูลโซนคะแนนสำหรับ Spymaster
    const [socket, setSocket] = useState(null);
    const [username, setUsername] = useState('');
    const [roomId, setRoomId] = useState('');
    const [currentRoomId, setCurrentRoomId] = useState('');
    const [players, setPlayers] = useState([]);
    const [gameState, setGameState] = useState('lobby'); // lobby, waiting, choosing_clue, guessing, revealing
    const [isSpymaster, setIsSpymaster] = useState(false);
    const [currentCard, setCurrentCard] = useState(null);
    const [targetValue, setTargetValue] = useState(null); // Spymaster เท่านั้นที่เห็น
    const [clue, setClue] = useState(''); // คำใบ้ที่ Spymaster พิมพ์
    const [currentClue, setCurrentClue] = useState(''); // คำใบ้ที่แสดงให้ทุกคนเห็น
    const [guessValue, setGuessValue] = useState(50); // ค่าที่ Psychics เดา (เริ่มต้นตรงกลาง)
    const [roundResult, setRoundResult] = useState(null); // ผลลัพธ์ของรอบ
    const [currentSpymasterId, setCurrentSpymasterId] = useState(null); // Store the current spymaster's socket ID

    useEffect(() => {
        // เชื่อมต่อ Socket.IO เมื่อ Component โหลด
        const newSocket = io(SOCKET_SERVER_URL);
        setSocket(newSocket);

        newSocket.on('connect', () => {
            console.log('Connected to server');
        });

        newSocket.on('error', (message) => {
            alert(`Error: ${message}`);
            console.error(message);
        });

        newSocket.on('roomCreated', (data) => {
            setCurrentRoomId(data.roomId);
            setPlayers(data.players);
            setGameState('waiting');
            console.log('Room created:', data);
        });

        newSocket.on('roomJoined', (data) => {
            setCurrentRoomId(data.roomId);
            setPlayers(data.players);
            setGameState(data.gameState === 'waiting' ? 'waiting' : 'guessing'); // ถ้าเกมเริ่มแล้วจะไปที่ guessing ทันที (หรือตามสถานะจริง)
            console.log('Room joined:', data);
        });

        newSocket.on('playerJoined', (data) => {
            setPlayers(data.players);
            console.log('Player joined:', data);
        });

        newSocket.on('playerLeft', (data) => {
            setPlayers(data.players);
            console.log('Player left:', data);
        });

        newSocket.on('newRound', (data) => {
            setCurrentCard(data.card);
            setClue(''); // Reset clue input
            setCurrentClue(''); // Clear previous clue
            setGuessValue(50); // Reset guess
            setTargetValue(null); // Clear target for non-Spymaster
            setScoreZones(null); // Clear score zones
            setRoundResult(null); // Clear previous round result
            setCurrentSpymasterId(data.spymasterId); // Set the spymaster ID for the round

            // ตรวจสอบว่าตัวเองเป็น Spymaster หรือไม่
            setIsSpymaster(data.spymasterId === newSocket.id);
            setPlayers(data.players); // อัปเดตคะแนนผู้เล่น

            if (data.spymasterId === newSocket.id) {
                setGameState('choosing_clue');
            } else {
                setGameState('guessing'); // Psychics จะเข้าสู่โหมดรอคำใบ้ หรือเดา
            }
            console.log('New Round started:', data);
        });

        newSocket.on('yourTurnToClue', (data) => {
            setCurrentCard(data.card);
            setTargetValue(data.targetValue);
            setScoreZones(data.scoreZones); // **รับข้อมูลโซนคะแนน**
            setGameState('choosing_clue');
            setIsSpymaster(true); // Confirm you are the spymaster
            setCurrentSpymasterId(newSocket.id); // Set yourself as the spymaster
            console.log('Your turn to give clue:', data);
        });

        newSocket.on('clueGiven', (data) => {
            setCurrentClue(data.clue);
            setCurrentCard(data.card); // อัปเดตการ์ดให้แน่ใจว่าทุกคนเห็นการ์ดเดียวกัน
            setGameState('guessing'); // ทุกคนเปลี่ยนสถานะเป็นรอเดา
            console.log('Clue given:', data);
        });

        newSocket.on('yourTurnToGuess', () => {
            setGameState('guessing');
            console.log('Your turn to guess!');
        });

        newSocket.on('guessSubmitted', (data) => {
            setGuessValue(data.guessValue); // แสดงค่าเดาของทีม (ถ้ามีแค่คนเดียว)
            setGameState('revealing');
            console.log('Guess submitted:', data);
        });

        newSocket.on('yourTurnToReveal', () => {
            setGameState('revealing');
            console.log('Spymaster: Your turn to reveal!');
        });

        newSocket.on('roundResult', (data) => {
            setRoundResult(data);
            setPlayers(data.totalScores); // อัปเดตคะแนนรวม
            setGameState('revealing');
            console.log('Round Result:', data);
        });

        return () => newSocket.disconnect(); // ตัดการเชื่อมต่อเมื่อ Component ถูกถอดออก
    }, []);

    const handleCreateRoom = () => {
        if (username.trim() && socket) {
            socket.emit('createRoom', username.trim());
        }
    };

    const handleJoinRoom = () => {
        if (username.trim() && roomId.trim() && socket) {
            socket.emit('joinRoom', { roomId: roomId.trim().toUpperCase(), username: username.trim() });
        }
    };

    const handleStartGame = () => {
        if (socket && currentRoomId) {
            socket.emit('startGame', currentRoomId);
        }
    };

    const handleSendClue = () => {
        if (socket && currentRoomId && clue.trim()) {
            socket.emit('sendClue', { roomId: currentRoomId, clue: clue.trim() });
            setGameState('guessing'); // Spymaster เปลี่ยนสถานะตัวเอง
        }
    };

    const handleSendGuess = () => {
        if (socket && currentRoomId) {
            socket.emit('sendGuess', { roomId: currentRoomId, guessValue: guessValue });
            setGameState('revealing'); // Psychics เปลี่ยนสถานะตัวเอง
        }
    };

    const handleRevealAnswer = () => {
        if (socket && currentRoomId) {
            socket.emit('revealAnswer', currentRoomId);
        }
    };

    // --- UI Components ---

    const renderLobby = () => (
        <div className="flex flex-col items-center justify-center h-screen bg-gray-100 p-4">
            <h1 className="text-5xl font-bold mb-8 text-blue-600">คลื่นคำ</h1>
            <input
                type="text"
                placeholder="ชื่อผู้ใช้"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                className="p-3 mb-4 border border-gray-300 rounded-lg w-full max-w-sm text-lg"
            />
            <button
                onClick={handleCreateRoom}
                className="bg-green-500 text-white p-3 rounded-lg w-full max-w-sm mb-4 text-xl font-semibold hover:bg-green-600 transition duration-200"
            >
                สร้างห้อง
            </button>
            <div className="flex w-full max-w-sm mb-4">
                <input
                    type="text"
                    placeholder="รหัสห้อง"
                    value={roomId}
                    onChange={(e) => setRoomId(e.target.value)}
                    className="p-3 border border-gray-300 rounded-l-lg flex-grow text-lg uppercase"
                />
                <button
                    onClick={handleJoinRoom}
                    className="bg-blue-500 text-white p-3 rounded-r-lg text-xl font-semibold hover:bg-blue-600 transition duration-200"
                >
                    เข้าร่วม
                </button>
            </div>
            <p className="text-gray-600 text-center mt-4">Wavelength เวอร์ชั่นภาษาไทย</p>
        </div>
    );

    const renderWaitingRoom = () => (
        <div className="flex flex-col items-center justify-center h-screen bg-gray-100 p-4">
            <h2 className="text-4xl font-bold mb-6 text-gray-800">ห้อง: {currentRoomId}</h2>
            <p className="text-xl mb-4">ผู้เล่น ({players.length}/5):</p>
            <ul className="list-disc list-inside mb-8 text-xl">
                {players.map((p) => (
                    <li key={p.id} className="mb-2">
                        {p.username} {p.id === socket.id ? '(คุณ)' : ''}
                    </li>
                ))}
            </ul>
            {players.length >= 2 && players[0].id === socket.id && ( // เฉพาะคนสร้างห้องและมีผู้เล่นพอถึงจะเห็นปุ่มเริ่ม
                <button
                    onClick={handleStartGame}
                    className="bg-purple-600 text-white p-4 rounded-lg text-2xl font-semibold hover:bg-purple-700 transition duration-200"
                >
                    เริ่มเกม
                </button>
            )}
            {players.length < 2 && (
                <p className="text-lg text-gray-600">รอผู้เล่นคนอื่นอย่างน้อย 2 คนเพื่อเริ่มเกม</p>
            )}
        </div>
    );

    // UI เกมฉบับปรับปรุง (ใช้ SVG)
    const renderGameUI = () => {
        const spymaster = players.find(p => p.id === currentSpymasterId);

        return (
            <div className="flex flex-col items-center justify-between h-screen bg-gray-50 p-6">
                {/* Header (แสดงผู้เล่นและคะแนน) */}
                <div className="w-full flex justify-between items-center mb-6">
                    <h2 className="text-2xl font-bold text-gray-700">ห้อง: {currentRoomId}</h2>
                    <div className="flex items-center space-x-4">
                        {players.map(p => (
                            <div key={p.id} className={`p-2 rounded-lg ${p.id === spymaster?.id ? 'bg-yellow-300' : 'bg-gray-200'}`}>
                                <span className="font-semibold text-gray-800">{p.username}</span>
                                <span className="text-sm ml-1">({p.score || 0})</span>
                                {p.id === spymaster?.id && (
                                    <span className="text-xs ml-1 text-red-500 font-bold">(ผู้ใบ้)</span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>

                {/* ครึ่งวงกลม Spectrum Container - ปรับขนาดและ padding/margin */}
                <div className="relative w-full max-w-xl h-[280px] flex flex-col items-center justify-center mb-8"> {/* Adjusted max-w and h */}
                    {currentCard && (
                        <>
                            <svg className="w-full h-full" viewBox="-60 0 300 100">
                                <defs>
                                    <linearGradient id="spectrumGradient" x1="0%" y1="0%" x2="100%" y2="0%">
                                        <stop offset="0%" stopColor="#ef4444" /> {/* แดง */}
                                        <stop offset="25%" stopColor="#f97316" /> {/* ส้ม */}
                                        <stop offset="50%" stopColor="#22c55e" /> {/* เขียว */}
                                        <stop offset="75%" stopColor="#0ea5e9" /> {/* ฟ้า */}
                                        <stop offset="100%" stopColor="#3b82f6" /> {/* น้ำเงิน */}
                                    </linearGradient>
                                </defs>

                                {/* [ใหม่] 1. วาดโซนคะแนน (สำหรับ Spymaster) */}
                                {isSpymaster && scoreZones && gameState === 'choosing_clue' && (
                                    <g>
                                        <path d="M0,100 A100,100 0 0,1 200,100" fill="none" stroke="#e5e7eb" strokeWidth="30" />

                                        {getSegments(scoreZones.zone1).map((seg, i) => (
                                            <ScoreZoneArc key={`z1-${i}`} segment={seg} radius={85} strokeWidth={30} color="#f97316" />
                                        ))}
                                        {getSegments(scoreZones.zone2).map((seg, i) => (
                                            <ScoreZoneArc key={`z2-${i}`} segment={seg} radius={85} strokeWidth={30} color="#facc15" />
                                        ))}
                                        {getSegments(scoreZones.zone3).map((seg, i) => (
                                            <ScoreZoneArc key={`z3-${i}`} segment={seg} radius={85} strokeWidth={30} color="#a3e635" />
                                        ))}
                                        {getSegments(scoreZones.zone4).map((seg, i) => (
                                            <ScoreZoneArc key={`z4-${i}`} segment={seg} radius={85} strokeWidth={30} color="#22c55e" />
                                        ))}
                                    </g>
                                )}

                                {/* 2. วาด Gradient (สำหรับ Psychic หรือตอนเฉลย) */}
                                {!(isSpymaster && scoreZones && gameState === 'choosing_clue') && (
                                    <path
                                        d="M0,100 A100,100 0 0,1 200,100"
                                        fill="none"
                                        stroke="url(#spectrumGradient)"
                                        strokeWidth="30"
                                    />
                                )}

                                {/* Target Value (Spymaster only) - เข็มเป้าหมาย */}
                                {isSpymaster && targetValue !== null && gameState === 'choosing_clue' && (
                                    <g>
                                        <line x1="100" y1="100" x2={getPointerPosition(targetValue, 95).x + 100} y2={getPointerPosition(targetValue, 95).y + 100} stroke="gold" strokeWidth="2" />
                                        <circle
                                            cx={getPointerPosition(targetValue, 95).x + 100}
                                            cy={getPointerPosition(targetValue, 95).y + 100}
                                            r="4" fill="gold" stroke="black" strokeWidth="1" className="animate-pulse"
                                        />
                                    </g>
                                )}

                                {/* Guess Pointer (เข็มที่เดา) */}
                                {(gameState === 'guessing' || gameState === 'revealing') && (
                                    <g>
                                        <line
                                            x1="100" y1="100"
                                            x2={getPointerPosition(guessValue, 90).x + 100}
                                            y2={getPointerPosition(guessValue, 90).y + 100}
                                            stroke="black" strokeWidth="2.5"
                                        />
                                        <circle
                                            cx={getPointerPosition(guessValue, 90).x + 100}
                                            cy={getPointerPosition(guessValue, 90).y + 100}
                                            r="6" fill="#3b82f6" stroke="white" strokeWidth="1.5"
                                        />
                                    </g>
                                )}

                                {/* Round Result (เข็มเป้าหมายจริง หลังเฉลย) */}
                                {roundResult && gameState === 'revealing' && (
                                    <g>
                                        <line
                                            x1="100" y1="100"
                                            x2={getPointerPosition(roundResult.targetValue, 95).x + 100}
                                            y2={getPointerPosition(roundResult.targetValue, 95).y + 100}
                                            stroke="gold" strokeWidth="2.5"
                                        />
                                        <circle
                                            cx={getPointerPosition(roundResult.targetValue, 95).x + 100}
                                            cy={getPointerPosition(roundResult.targetValue, 95).y + 100}
                                            r="6" fill="gold" stroke="black" strokeWidth="1.5" className="animate-pulse"
                                        />
                                    </g>
                                )}
                            </svg>

                            {/* คำคู่ Spectrum (วางตำแหน่งทับ SVG) */}
                            <div className="absolute top-0 left-0 w-full flex justify-between px-8"> {/* Adjusted px */}
                                <span className="text-xl font-bold text-gray-700 w-1/3 text-left">{currentCard.left}</span>
                                <span className="text-xl font-bold text-gray-700 w-1/3 text-right">{currentCard.right}</span>
                            </div>

                            {/* คำใบ้ (Clue) (วางตำแหน่งทับ SVG) */}
                            {currentClue && (
                                <p className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[40px] text-5xl font-bold text-gray-800 break-words text-center w-3/4"> {/* Adjusted -translate-y */}
                                    {currentClue}
                                </p>
                            )}
                            {!currentClue && gameState === 'guessing' && (
                                <p className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-[40px] text-2xl text-gray-600"> {/* Adjusted -translate-y */}
                                    รอ Spymaster ใบ้คำ...
                                </p>
                            )}

                            {/* [ใหม่] แสดงคะแนนที่ได้ (ตอนเฉลย) */}
                            {roundResult && gameState === 'revealing' && (
                                <div className="absolute top-1/2 left-1/2 -translate-x-1/2 translate-y-[40px] bg-green-500 text-white text-3xl font-bold p-4 rounded-full animate-bounce">
                                    +{roundResult.scoreThisRound} แต้ม!
                                </div>
                            )}
                        </>
                    )}
                </div>

                {/* Slider สำหรับ Psychics */}
                {(!isSpymaster && (gameState === 'guessing')) && (
                    <div className="w-full max-w-[500px] text-center">
                        <input
                            type="range"
                            min="0"
                            max="100"
                            value={guessValue}
                            onChange={(e) => setGuessValue(parseInt(e.target.value))}
                            className="w-full h-3 bg-gray-300 rounded-lg appearance-none cursor-pointer"
                            style={{ '--tw-range-thumb-bg': '#3b82f6' }} // สำหรับ CSS ใน index.css
                        />
                        <span className="text-2xl font-bold text-blue-600">{guessValue}</span>
                    </div>
                )}
                {/* แสดงค่าที่ล็อคไว้ตอนรอเฉลย */}
                {(!isSpymaster && (gameState === 'revealing')) && (
                    <div className="w-full max-w-[500px] text-center">
                        <p className="text-xl">คุณเดาที่: <span className="text-2xl font-bold text-blue-600">{guessValue}</span></p>
                    </div>
                )}


                {/* Actions for Spymaster */}
                {isSpymaster && gameState === 'choosing_clue' && (
                    <div className="flex flex-col items-center">
                        <p className="text-xl mb-4 text-gray-700">คุณคือ Spymaster! เป้าหมายคือ <span className="font-bold text-2xl text-yellow-600">{targetValue}</span></p>
                        <input
                            type="text"
                            placeholder="พิมพ์คำใบ้ของคุณ..."
                            value={clue}
                            onChange={(e) => setClue(e.target.value)}
                            className="p-3 border border-gray-300 rounded-lg w-80 mb-4 text-lg"
                        />
                        <button
                            onClick={handleSendClue}
                            className="bg-purple-600 text-white p-3 rounded-lg w-80 text-xl font-semibold hover:bg-purple-700 transition duration-200"
                        >
                            ส่งคำใบ้
                        </button>
                    </div>
                )}

                {/* Actions for Psychics */}
                {!isSpymaster && gameState === 'guessing' && (
                    <div className="flex flex-col items-center">
                        <p className="text-xl mb-4 text-gray-700">คุณคือผู้เดา! ปรึกษากับเพื่อนแล้วเลื่อนตัวชี้</p>
                        <button
                            onClick={handleSendGuess}
                            className="bg-blue-600 text-white p-3 rounded-lg w-80 text-xl font-semibold hover:bg-blue-700 transition duration-200"
                        >
                            ล็อคคำตอบ
                        </button>
                    </div>
                )}

                {/* Reveal button for Spymaster */}
                {isSpymaster && gameState === 'revealing' && !roundResult && (
                    <button
                        onClick={handleRevealAnswer}
                        className="bg-red-600 text-white p-3 rounded-lg w-80 text-xl font-semibold hover:bg-red-700 transition duration-200"
                    >
                        เปิดเผยคำตอบ
                    </button>
                )}

                {/* Waiting text */}
                {((!isSpymaster && gameState === 'revealing' && !roundResult) || (isSpymaster && gameState === 'guessing')) && (
                    <p className="text-2xl text-gray-600 animate-pulse">
                        {isSpymaster ? "รอทีมเดา..." : "รอ Spymaster เปิดเผย..."}
                    </p>
                )}

                {/* Next Round (แสดงหลังเฉลยแล้ว) */}
                {roundResult && gameState === 'revealing' && (
                    <p className="text-xl text-gray-700 animate-pulse">
                        กำลังเริ่มรอบต่อไป...
                    </p>
                    // Server จะส่ง 'newRound' มาอัตโนมัติ (ตามโค้ด server.js)
                )}

            </div>
        );
    }


    return (
        <div className="App">
            {gameState === 'lobby' && renderLobby()}
            {gameState === 'waiting' && renderWaitingRoom()}
            {(gameState === 'choosing_clue' || gameState === 'guessing' || gameState === 'revealing') && renderGameUI()}
        </div>
    );
}

export default App;
