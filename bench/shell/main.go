// MyGo shell for the MyGo + Rust benchmark (webview mode). Benchmark only.
//
//	od-mygo -mode coldstart -dir <renderer dir>
//	    Loads the existing OpenDecks renderer (renderer/index.html + app.js)
//	    as the MyGo frontend. bench-ff.js in the page calls Bench.FirstFrame
//	    after the second animation frame; the shell prints FIRST_FRAME and
//	    keeps running (the harness reads idle RAM, then kills it).
//	od-mygo -mode playback -dir <playback dir> -seconds 300
//	    Serves the AudioWorklet playback test from a loopback HTTP server
//	    (WebKitGTK cannot play media from custom schemes) and prints the
//	    PLAYBACK result line the page POSTs back, then quits.
package main

import (
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"time"

	"github.com/egoist/mygo"
)

var start = time.Now()

// Bench is called from the renderer page.
type Bench struct{}

// FirstFrame reports that the page painted its second frame, with the
// script errors the page saw (JSON array).
func (Bench) FirstFrame(errors string) {
	fmt.Printf("FIRST_FRAME %.1f %s\n", float64(time.Since(start).Microseconds())/1000, errors)
	os.Stdout.Sync()
}

func main() {
	mode := flag.String("mode", "coldstart", "coldstart | playback")
	dir := flag.String("dir", "renderer", "directory to serve")
	seconds := flag.Int("seconds", 300, "playback test length")
	flag.Parse()

	switch *mode {
	case "coldstart":
		mygo.Bind(Bench{})
		mygo.SetFrontend(os.DirFS(*dir))
		mygo.App.WhenReady(func() {
			mygo.NewWindow(mygo.WindowOptions{Title: "OpenDecks", URL: "/index.html", Width: 1500, Height: 980})
		})
	case "playback":
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			log.Fatal(err)
		}
		mux := http.NewServeMux()
		mux.Handle("/", http.FileServer(http.Dir(*dir)))
		mux.HandleFunc("/result", func(w http.ResponseWriter, r *http.Request) {
			b, _ := io.ReadAll(r.Body)
			fmt.Printf("PLAYBACK %s\n", b)
			os.Stdout.Sync()
			w.WriteHeader(204)
			go func() { time.Sleep(200 * time.Millisecond); mygo.App.Quit() }()
		})
		go http.Serve(ln, mux)
		url := fmt.Sprintf("http://%s/index.html?seconds=%d&host=mygo", ln.Addr().String(), *seconds)
		mygo.App.WhenReady(func() {
			mygo.NewWindow(mygo.WindowOptions{Title: "OpenDecks playback test", URL: url, Width: 800, Height: 600})
		})
	}
	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}
