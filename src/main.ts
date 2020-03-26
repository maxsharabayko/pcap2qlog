import * as fs from "fs";
import * as path from "path";
import {promisify} from "util";

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

import {Downloader} from "./flow/downloader";
import { mkDirByPathSync, createHash, fileIsJSON, fileIsPCAP, fileIsSECRETS, fileIsQLOG } from "./util/FileUtil";
import {PCAPToJSON} from "./flow/pcaptojson";
import {JSONToQLog} from "./flow/jsontoqlog";
import * as qlog from "@quictools/qlog-schema";
import { VantagePointType, ITrace, ITraceError } from "@quictools/qlog-schema";
import { qlogFullToQlogLookup } from "./converters/qlogFullToQlogLookup";
import { qlogFullToQlogMinified } from "./converters/qlogFullToQlogMinified";
import { qlogFullToQlogProtobuf } from "./converters/qlogFullToProtobuf";

// Parse CLI arguments
let args = require('minimist')(process.argv.slice(2));

// CLI arguments
// we expect the input file to be EITHER a JSON file of the format:
/*
    {
        "description": "top-level description",
        "paths": [
            { "capture": "https://...", "secrets": "https://...", "description" : "per-file desc" }
        ]
    }
*/
// then use the --list option
// OR a single file-path (or URL), with or without the secrets_file set
// then use the --input option
// e.g.,
// node main.js --list=/allinone.json --output=/srv/qvis-cache
// OR
// node main.js --input=/decrypted.json  --output=/srv/qvis-cache
// OR
// node main.js --input=/encrypted.pcap --secrets=/secrets.keys  --output=/srv/qvis-cache
// NOTE: this tool can also be used to merge together multiple (partial) qlog files
//  for this, just pass the files with the --list option
// This tool uses tshark for the conversion of pcap to json and should therefore be given a path to your local install of the program
// This can be done using the --tshark flag (or -t)
// The default tshark location used is /wireshark/run/tshark which will generally not be correct if you are running this outside of a docker. It is thus recommended to pass the path to your local install.
let input_list: string           = args.l || args.list;
let input_file: string           = args.i || args.input;
let secrets_file: string         = args.s || args.secrets;
let output_directory: string     = args.o || args.output    || "/srv/qvis-cache"; // output will be placed in args.o/cache/generatedfilename.json  and temp storage is  args.o/inputs/
let output_path: string          = args.p || args.outputpath;   // output will be placed in args.p  and temp storage is  args.o/inputs/
let tsharkLocation: string       = args.t || args.tshark || "/wireshark/run/tshark"; // Path to the TShark executable
let logRawPayloads: boolean      = args.r || args.raw || false; // If set to false, raw decrypted payloads will not be logged. This is default behaviour as payloads have a huge impact on log size.

let converterName: string        = args.m || args.mode || "pcap2qlog";
let input_directory: string      = args.d || args.inputdir;

if( !input_file && !input_list ){
    console.error("No input file or list of files specified, use --input or --list");
    process.exit(1);
}

if( !output_directory ){
    console.error("Please specify an output_directory, even if you have specified an output_path (needed for temp file storage)");
    process.exit(1);
}

async function PcapToQlogFlow() {

    let inputIsList:boolean = input_list !== undefined;

    // each session gets their own temporary input directory so we can easily remove it from disk after everything is done
    let tempDirectory = path.resolve( output_directory + path.sep + "inputs" );
    tempDirectory += path.sep + Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    mkDirByPathSync( tempDirectory );

    // 1. make single input format
    // we have 3 options:
    // a. it's a custom json file with many different input files (either .qlog, .json or .pcap/pcapng) and possibly keys
    // b. it's just a single decrypted json file (tshark output)
    // c. it's just a single pcap or pcapng file and possibly a single key file
    // -> we rework b. and c. to the format of a. for easier manipulation later

    interface ICapture {
        qlog?:qlog.IQLog;
        capture_original:string; // for proper debugging
        capture:string;
        secrets_original?:string; // for proper debugging
        secrets?:string;
        error?:string;
        description?:string;
    }

    let inputList:Array<ICapture> = [];
    let inputListDescription:string = "";
    let inputListRawString:string = "";

    if( !inputIsList ){
        if( fileIsJSON(input_file) ){ // tshark json file
            inputList.push( {capture : input_file, capture_original: input_file } );
        }
        else{
            if( secrets_file !== undefined && secrets_file !== "" )
                inputList.push( {capture : input_file, capture_original: input_file, secrets: secrets_file, secrets_original: secrets_file } );
            else
                inputList.push( {capture : input_file, capture_original: input_file } );
        }
    }
    else{
        try{
            let listLocalFilePath:string = await Downloader.DownloadIfRemote( input_list, tempDirectory );
            inputListRawString = fs.readFileSync( listLocalFilePath ).toString();
            let inputListJSON:any = JSON.parse( inputListRawString );

            inputListDescription = inputListJSON.description ? inputListJSON.description : input_file; // default description is the file path itself
            inputList = inputListJSON.paths;
            for( let capt of inputList ){
                capt.capture_original = capt.capture;
                capt.secrets_original = capt.secrets_original;
            }
        }
        catch(e){
            console.error("Error downloading list file " + e.toString());
            process.exit(2);
        }
    }

    // TODO: first check cache to see if we haven't already done this process for this file or file-list before
    let calculateStableHash = function():string {
        let output:string = "";
        if( inputIsList ){
            // we're not just using the filename, because this is more flexible, especially if the contents are made on-the-fly
            output = createHash( inputListRawString );
        }
        else{
            output = createHash( input_file + secrets_file );
        }

        return output;
    }


    // 2. now we have a nice list of files (possibly with secrets) that we would like to download
    // These files can either be local or remote, so we should always download them first if needed

    let download = async function(capt:ICapture, outputDirectory:string):Promise<ICapture> {
        //let output:ICapture = { capture: "", capture_original: capt.capture_original, secrets_original: capt.secrets_original };

        if( capt.error )
            return capt;

        // we can't just throw errors, because that would fail the full Promise.all,
        // while we just want to skip the files that don't work and show an error message
        try{
            capt.capture = await Downloader.DownloadIfRemote( capt.capture, tempDirectory );
        }
        catch(e){
            capt.error = e;
        }
        if( capt.secrets ){
            try{
                capt.secrets = await Downloader.DownloadIfRemote( capt.secrets, tempDirectory );
            }
            catch(e){
                capt.error = e;
            }
        }

        return capt;
    };

    // note: we could do download + tshark calls in 1 long async function, but for clarity we keep them separate
    // performance should be relatively ok, unless there is a single file that is MUCH bigger than the rest of course
    let downloadPromises = [];
    for( let capture of inputList ){
        downloadPromises.push( download(capture, tempDirectory) );
    }

    let downloadedFiles = await Promise.all( downloadPromises );


    // 3. now we have the files all local and the like
    // now we need to transform any pcap or pcapng files to the tshark json format
    let tshark = async function(capt:ICapture, outputDirectory:string):Promise<ICapture> {
        if( capt.error )
            return capt;

        if( fileIsJSON(capt.capture) || fileIsQLOG(capt.capture) )
            return capt;

        // TODO: we explicitly do NOT check for .pcap or .pcapng here to allow for most flexibility
        // this may come back to bite us in the *ss later

        try{
            capt.capture = await PCAPToJSON.TransformToJSON( capt.capture, tempDirectory, tsharkLocation, capt.secrets );
        }
        catch(e){
            capt.error = e;
        }

        return capt;
    };

    let tsharkPromises = [];
    for( let capture of downloadedFiles ){
        tsharkPromises.push( tshark(capture, tempDirectory) );
    }

    let tsharkFiles = await Promise.all( tsharkPromises );


    // 3. so now everything should be in either .json or .qlog format
    // we now want to transform tshark's .json schema into our .qlog schema
    let transform = async function(capt:ICapture, outputDirectory:string):Promise<ICapture>{
        if( capt.error )
            return capt;

        if( fileIsQLOG(capt.capture) ){
            // we already had a qlog file from the beginning
            // just read it and use it directly
            let fileContents:Buffer = await readFileAsync( capt.capture );
            capt.qlog = JSON.parse(fileContents.toString());
            return capt;
        }

        try{
            // we don't write to file here, but pass the qlog object around directly to write a combined file later
            capt.qlog = await JSONToQLog.TransformToQLog( capt.capture, tempDirectory, capt.capture_original, logRawPayloads, capt.secrets );
        }
        catch(e){
            // console.error("ERROR transforming", e);
            capt.error = e;
        }

        return capt;
    }

    let transformPromises = [];
    for( let capture of tsharkFiles ){
        transformPromises.push( transform(capture, tempDirectory) );
    }

    let transformFiles = await Promise.all( transformPromises );


    // 4. now, we finally have all the qlog files
    // If there are indeed multiple, we want to combine those into a single big qlog file

    // the capt.qlog data structures are FULL qlogs, so we need to extract the separate connections
    // to make a new FULL qlog that combines all of them

    let combined:qlog.IQLog = {
        qlog_version: "draft-01",
        // TODO Title?
        description: inputListDescription,
        // TODO Summary?
        traces: []
    };

    for( let capt of transformFiles ){
        if( capt.qlog ){
            combined.qlog_version = capt.qlog.qlog_version;

            // valid qlog found
            //if( !capt.description )
            //    capt.description = capt.capture_original; // use the filename as the description

            // we basically just throw away all the top-level qlog stuff
            // and transfer over all connection-specific information to the combined file
            for( let trace of capt.qlog.traces ){
                if ( (trace as ITrace).description !== undefined ) {
                    trace = trace as ITrace;
                    trace.description = capt.description;
                }

                combined.traces.push( trace );
            }
        }
        else if( capt.error ){
            // we want to reflect the errors in the resulting qlog file instead of just returning nothing
            const err:qlog.ITraceError = {
                error_description: ("" + capt.error),
                uri: capt.capture_original,
            };

            combined.traces.push( err );
        }
        else{
            console.error("main:combining : something went wrong. we have a capture we cannot process.", capt);
        }
    }

    // 5. we now have a single, combined IQLog file
    // we want to save this to disk so we can later use that as a cache
    // we need the filename to be stable, so we hash either the file+secrets paths OR the contents of the json list file
    let outputPath:string = output_path;
    if( !outputPath ){
        let outputFilename:string = calculateStableHash() + ".qlog";

        let outputDirectory = path.resolve( output_directory + path.sep + "cache" );
        mkDirByPathSync( outputDirectory );

        outputPath = outputDirectory + path.sep + outputFilename;
    }

    await writeFileAsync( outputPath, JSON.stringify(combined, null, 4) );

    console.log( outputPath );

    /*
    console.log("Input list : ", inputList);
    console.log("Downloaded files : ", downloadedFiles);
    console.log("Tsharked files : ", tsharkFiles);
    console.log("Transformed files : ", transformFiles);

    console.log("Combined output path : ", outputDirectory + path.sep + outputFilename );
    */

};

async function ConverterFlow(chosenConverter:string) {
    // for now, only support reading from local disk, no downloading

    const inputFilePaths = Array<string>();

    if ( input_directory !== undefined ) {
        // FIXME: read all files from input dir
    } 
    else if ( input_file ) {
        inputFilePaths.push( input_file );
    }
    else {
        console.error("ConverterFlow: no input dir or file given!");
        return;
    }

    if ( output_directory === undefined ) {
        console.error("ConverterFlow: no output dir or file given!");
        return;
    }

    let transform = async function(inputFilePath:string, outputDirectory:string):Promise<boolean>{

        console.log("Transforming", chosenConverter, inputFilePath );

        let inputFileContents = await readFileAsync( inputFilePath );

        let result:Buffer|string = "";
        let outputExtension:string = ".qlog";

        if ( chosenConverter === "jsonMinify" ) {
            result = await qlogFullToQlogMinified.Convert( inputFileContents.toString(), path.basename(inputFilePath) );
            outputExtension = path.extname(inputFilePath);
        }
        else if ( chosenConverter === "qlogLookup" ) {
            result = await qlogFullToQlogLookup.Convert( inputFileContents.toString(), path.basename(inputFilePath) );
        }
        else if ( chosenConverter === "qlogLookupUndo" ){
            result = await qlogFullToQlogLookup.Undo( inputFileContents.toString(), path.basename(inputFilePath) );
        }
        else if ( chosenConverter === "qlogProtobuf" ){
            result = await qlogFullToQlogProtobuf.Convert( inputFileContents.toString(), path.basename(inputFilePath) );
            outputExtension = ".protobuf";
        }
        else {
            console.error( "ConverterFLow: unsupported converter mode ", chosenConverter );

            return false;
        }

        mkDirByPathSync( outputDirectory );

        const outputPath = outputDirectory + path.sep +  path.basename(inputFilePath, path.extname(inputFilePath) ) + "_" + chosenConverter + outputExtension;

        await writeFileAsync( outputPath, result );

        console.log("File written", outputPath);

        return true;
    }

    let transformPromises = [];
    for( let filePath of inputFilePaths ){
        transformPromises.push( transform(filePath, output_directory) );
    }

    await Promise.all( transformPromises );
}


if ( converterName === "pcap2qlog" ){
    PcapToQlogFlow().then( () => {
        //console.log("Executing fully done");
        process.exit(0);
    }).catch( (reason) => {
        console.error("Top level error " + reason);
        process.exit(3);
    });
}
else {

    // node out/main.js --mode=qlogLookup --input=/home/rmarx/WORK/binary/input/test.qlog --output=/home/rmarx/WORK/binary/output
    // console.log("CONVERTING ", converterName, output_directory, input_file);

    ConverterFlow(converterName).then( () => {
        console.log("Executing converterflow fully done");
        process.exit(0);
    })
    /*.catch( (reason) => {
        console.error("Top level error " + reason);
        process.exit(3);
    });
    */
}