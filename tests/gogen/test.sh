#! /bin/bash
ROOT_DIR=../..
BUILD_DIR=$ROOT_DIR/built
TESTS_BUILD_DIR=$BUILD_DIR/tests
BUILT_COMPILER=$BUILD_DIR/local/tsc.js

files=$1
if [ -z $files ]; then
    files=./*.ts
fi

for file in $files
do
  echo "Testing $file... "
  basename=${file%.*}
  tsc --outDir $TESTS_BUILD_DIR $file
  jsfile=$basename.js
  gofile=$basename.go
  expected=`node $TESTS_BUILD_DIR/$jsfile`
  node $BUILT_COMPILER --outDir $TESTS_BUILD_DIR $file
  got=`go run $TESTS_BUILD_DIR/$gofile`

  expected_t=`echo "$expected" | xargs`
  got_t=`echo "$got" | xargs`
  if [ "$expected_t" != "$got_t" ]; then
      echo "Failed: expected '$expected_t', got '$got_t'"
  else
      echo "OK."
  fi
  echo "---------------------------------"
  done
